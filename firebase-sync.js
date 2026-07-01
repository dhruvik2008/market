/* ================================================
   VASTRA – Firebase Realtime Sync Layer (Smart Merge)
   Anonymous Auth + Realtime Database
================================================ */

// ── Firebase Config ──────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDMryufTWeY6io9jYpFf6zM466ShDiooBk",
  authDomain: "market-38c56.firebaseapp.com/* ================================================
   VASTRA – Firebase Realtime Sync Layer (Smart Merge)
   Anonymous Auth + Realtime Database
================================================ */

// ── Firebase Config ──────────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyDMryufTWeY6io9jYpFf6zM466ShDiooBk",
  authDomain: "market-38c56.firebaseapp.com",
  databaseURL: "https://market-38c56-default-rtdb.firebaseio.com",
  projectId: "market-38c56",
  storageBucket: "market-38c56.firebasestorage.app",
  messagingSenderId: "454864357330",
  appId: "1:454864357330:web:cff523c0e8e40c80b9ea0b",
  measurementId: "G-KTRFEHP30Z"
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const fbAuth = firebase.auth();
const fbDB = firebase.database();
const analytics = firebase.analytics();

// ── Data keys to sync ────────────────────────────
// Note: vastra_designs is handled specially via VastraDB
const SYNC_KEYS = [
    'vastra_challans',
    'vastra_packs',
    'vastra_customers',
    'vastra_agents',
    'vastra_invoices',
    'vastra_salesReturns',
    'vastra_categoryTypes',
    'vastra_role_permissions',
    'vastra_supplier'
];

// ── State ────────────────────────────────────────
let fbUserId = null;
let fbReady = false;
let fbConnected = false;
let _suppressFirebaseWrite = false; // prevent write loops
let _syncDebounceTimers = {};
let _lastLocalJSON = {};           // Cache to detect redundant writes
let _pendingLocalKeys = new Set(); // Keys with local writes not yet pushed to Firebase

// ── Status UI ────────────────────────────────────
function updateSyncStatus(status) {
    const el = document.getElementById('syncStatusIndicator');
    if (!el) return;
    
    switch(status) {
        case 'online':
            el.innerHTML = '<i class="fa fa-cloud" style="color:#4caf50"></i>';
            el.title = 'Connected to Cloud';
            break;
        case 'offline':
            el.innerHTML = '<i class="fa fa-cloud" style="color:#9e9e9e"></i>';
            el.title = 'Offline';
            break;
        case 'syncing':
            el.innerHTML = '<i class="fa fa-sync fa-spin" style="color:#0088cc"></i>';
            el.title = 'Syncing...';
            break;
    }
}

// ── Helpers ──────────────────────────────────────
function smartMerge(local, remote) {
    if (!remote) return local;
    if (!local) return remote;

    // For non-array objects (supplier, permissions)
    if (!Array.isArray(local) || !Array.isArray(remote)) {
        const localTs = local.updatedAt || 0;
        const remoteTs = remote.updatedAt || 0;
        // If both have timestamps: pick newest
        // If neither has timestamps OR local is newer: keep local
        if (remoteTs > localTs) return remote;
        return local; // Default: keep local (don't let stale cloud overwrite fresh local)
    }

    const map = new Map();
    // Add local items
    local.forEach(item => {
        if (item && item.id) map.set(item.id, item);
    });
    // Merge remote items
    remote.forEach(remoteItem => {
        if (!remoteItem || !remoteItem.id) return;
        const localItem = map.get(remoteItem.id);
        if (!localItem || (remoteItem.updatedAt || 0) >= (localItem.updatedAt || 0)) {
            map.set(remoteItem.id, remoteItem);
        }
    });

    let mergedArray = Array.from(map.values());
    
    // Aggressive cleanup: strip imgSrc from items to prevent QuotaExceededError
    mergedArray.forEach(entry => {
        if (entry && entry.items) {
            entry.items.forEach(item => {
                if (item.imgSrc && item.imgSrc.length > 50) {
                    delete item.imgSrc;
                }
            });
        }
    });

    return mergedArray;
}

// ── Anonymous Auth ───────────────────────────────
function firebaseInit() {
    // Monitor connection
    fbDB.ref(".info/connected").on("value", (snap) => {
        fbConnected = (snap.val() === true);
        if (fbConnected) {
            console.log('🌐 Firebase Connected');
            updateSyncStatus('online');
        } else {
            console.log('🌐 Firebase Disconnected');
            updateSyncStatus('offline');
        }
    });

    fbAuth.signInAnonymously()
        .then(() => console.log('✅ Firebase Auth successful'))
        .catch(err => console.error('❌ Firebase Auth failed:', err));

    fbAuth.onAuthStateChanged((user) => {
        if (user) {
            fbUserId = user.uid;
            fbReady = true;
            console.log('🔑 Firebase Ready:', fbUserId);
            startFirebaseListeners();
            // Initial sync: fetch everything first
            SYNC_KEYS.forEach(key => pullAndMerge(key));
            pullAndMergeDesigns();
            startDeepSyncPoller();
        } else {
            fbUserId = null;
            fbReady = false;
        }
    });
}

// ── Pull and Merge ───────────────────────────────
async function pullAndMerge(key) {
    if (!fbReady) return;
    updateSyncStatus('syncing');
    const ref = fbDB.ref(`vastra_shared_data/${key}`);
    ref.once('value').then(snapshot => {
        const fbData = snapshot.val();
        if (!fbData) {
            updateSyncStatus('online');
            return;
        }

        const localData = JSON.parse(localStorage.getItem(key) || (key.includes('supplier') || key.includes('permission') ? '{}' : '[]'));
        const merged = smartMerge(localData, fbData);

        const mergedJSON = JSON.stringify(merged);
        const localJSON = JSON.stringify(localData);
        _lastLocalJSON[key] = mergedJSON;
        
        if (mergedJSON !== localJSON) {
            _suppressFirebaseWrite = true;
            localStorage.setItem(key, mergedJSON);
            _suppressFirebaseWrite = false;
            console.log(`⬇️ Merged ${key} from Cloud`);
            if (typeof refreshUIForKey === 'function') refreshUIForKey(key);
            
            // Note: We don't need to push back here because the listener/transaction logic will handle it if needed
        }
        updateSyncStatus('online');
    });
}

async function pullAndMergeDesigns() {
    if (!fbReady || typeof VastraDB === 'undefined') return;
    updateSyncStatus('syncing');
    const ref = fbDB.ref(`vastra_shared_data/vastra_designs`);
    ref.once('value').then(async (snapshot) => {
        let fbData = snapshot.val();
        if (!fbData) {
            updateSyncStatus('online');
            return;
        }
        if (!Array.isArray(fbData) && typeof fbData === 'object') fbData = Object.values(fbData);

        const localDesigns = await VastraDB.getAll();
        const merged = smartMerge(localDesigns, fbData);
        // Sort merged designs numerically
        merged.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
        const mergedJSON = JSON.stringify(merged);
        _lastLocalJSON['vastra_designs'] = mergedJSON;

        if (mergedJSON !== JSON.stringify(localDesigns)) {
            _suppressFirebaseWrite = true;
            await VastraDB.saveAll(merged);
            _suppressFirebaseWrite = false;
            console.log(`⬇️ Merged vastra_designs from Cloud`);
            if (typeof refreshUIForKey === 'function') refreshUIForKey('vastra_designs');

            // Push back merged result
            window.syncDesignsToFirebaseManual();
        }
        updateSyncStatus('online');
    });
}

// ── Real-time Listeners ──────────────────────────
function startFirebaseListeners() {
    if (!fbReady) return;

    SYNC_KEYS.forEach(key => {
        fbDB.ref(`vastra_shared_data/${key}`).on('value', (snapshot) => {
            // If we have a PENDING local write for this key (e.g. a delete not yet pushed
            // to Firebase), do NOT let the old cloud data overwrite our local change.
            if (_pendingLocalKeys.has(key)) {
                console.log(`⏳ Listener skipped for ${key} (local write pending)`);
                return;
            }
            const fbData = snapshot.val();
            const isObjKey = key.includes('supplier') || key.includes('permission');
            const localDataStr = localStorage.getItem(key) || (isObjKey ? '{}' : '[]');
            const fbDataStr = JSON.stringify(fbData || (isObjKey ? {} : []));

            // Authoritative Mirroring: If cloud data is different, adopt it entirely
            if (fbDataStr !== localDataStr) {
                _suppressFirebaseWrite = true;
                _originalSetItem(key, fbDataStr);   // use original to avoid re-triggering
                _suppressFirebaseWrite = false;
                console.log(`✨ Automatic Sync (Mirror): ${key}`);
                if (typeof refreshUIForKey === 'function') refreshUIForKey(key);
            }
        });
    });

    fbDB.ref(`vastra_shared_data/vastra_designs`).on('value', async (snapshot) => {
        if (_pendingLocalKeys.has('vastra_designs')) {
            console.log(`⏳ Design listener skipped (local write pending)`);
            return;
        }
        if (typeof VastraDB === 'undefined') return;
        let fbData = snapshot.val();
        if (!fbData) fbData = []; 
        if (!Array.isArray(fbData) && typeof fbData === 'object') fbData = Object.values(fbData);

        try {
            const fbDataStr = JSON.stringify(fbData);
            if (fbDataStr === _lastLocalJSON['vastra_designs']) return;

            const localDesigns = await VastraDB.getAll();
            const merged = smartMerge(localDesigns, fbData);
            const mergedJSON = JSON.stringify(merged);

            if (mergedJSON !== JSON.stringify(localDesigns)) {
                _suppressFirebaseWrite = true;
                _lastLocalJSON['vastra_designs'] = mergedJSON;
                await VastraDB.saveAll(merged);
                _suppressFirebaseWrite = false;
                console.log(`✨ Automatic Sync (Merge): vastra_designs`);
                if (typeof refreshUIForKey === 'function') refreshUIForKey('vastra_designs');
            }
        } catch (e) {
            _suppressFirebaseWrite = false;
            console.error("Listener vastra_designs error:", e);
        }
    });
}

// ── Transactional Sync ──────────────────────────
function syncToFirebase(key) {
    if (!fbReady || _suppressFirebaseWrite) return;

    clearTimeout(_syncDebounceTimers[key]);
    _syncDebounceTimers[key] = setTimeout(() => {
        const localDataRaw = localStorage.getItem(key);
        if (!localDataRaw) return;

        const localData = JSON.parse(localDataRaw);
        updateSyncStatus('syncing');

        // AUTHORITATIVE PUSH: local is source of truth
        fbDB.ref(`vastra_shared_data/${key}`).set(localData, (error) => {
            if (error) {
                console.error(`Sync failed for ${key}:`, error);
            } else {
                _lastLocalJSON[key] = localDataRaw;
                _pendingLocalKeys.delete(key); // ✅ Push done — listener can now accept cloud
                console.log(`✅ ${key} synced to cloud (Authoritative)`);
            }
            updateSyncStatus('online');
        });
    }, 150);
}

window.syncDesignsToFirebaseManual = async function () {
    if (!fbReady || _suppressFirebaseWrite || typeof VastraDB === 'undefined') return;

    _pendingLocalKeys.add('vastra_designs'); // ✅ Mark as pending

    clearTimeout(_syncDebounceTimers['vastra_designs']);
    _syncDebounceTimers['vastra_designs'] = setTimeout(async () => {
        try {
            const localDesigns = await VastraDB.getAll();
            const localDataStr = JSON.stringify(localDesigns);
            
            if (localDataStr === _lastLocalJSON['vastra_designs']) {
                _pendingLocalKeys.delete('vastra_designs');
                return;
            }

            updateSyncStatus('syncing');
            
            // AUTHORITATIVE PUSH: IndexedDB Designs to Firebase
            fbDB.ref(`vastra_shared_data/vastra_designs`).set(localDesigns, (error) => {
                _pendingLocalKeys.delete('vastra_designs'); // ✅ Push done
                if (error) {
                    console.error('Design sync failed:', error);
                } else {
                    _lastLocalJSON['vastra_designs'] = localDataStr;
                    console.log('✅ designs synced to cloud');
                }
                updateSyncStatus('online');
            });
        } catch (e) {
            _pendingLocalKeys.delete('vastra_designs');
            console.error("Manual sync designs error:", e);
        }
    }, 200); // 200ms debounce
}

// ── Background Deep Sync (Every 10s) ──────────────
// This ensures that even if a websocket event was missed, data is 100% consistent across devices.
function startDeepSyncPoller() {
    setInterval(() => {
        if (!fbReady || !fbConnected) return;
        console.log('🔄 Deep Sync: Verifying consistency...');
        SYNC_KEYS.forEach(key => pullAndMerge(key));
        pullAndMergeDesigns();
    }, 10000); // 10 second goal
}

// ── UI Refresh ───────────────────────────────────
function refreshUIForKey(key) {
    try {
        switch (key) {
            case 'vastra_designs':
                if (typeof VastraDB !== 'undefined') {
                    VastraDB.getAll().then(res => {
                        // Sort designs numerically
                        designs = res.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
                        if (typeof renderDesignsTable === 'function') renderDesignsTable();
                        if (typeof updateStats === 'function') updateStats();
                    });
                }
                break;
            case 'vastra_challans':
                challans = JSON.parse(localStorage.getItem('vastra_challans') || '[]');
                if (typeof renderChallanList === 'function') renderChallanList();
                if (typeof updateStats === 'function') updateStats();
                // Refresh detail if open
                if (typeof currentDetailChallan !== 'undefined' && currentDetailChallan && typeof renderChallanDetail === 'function') {
                    const fresh = challans.find(c => c.id === currentDetailChallan.id);
                    if (fresh) renderChallanDetail(fresh);
                }
                // Refresh stock views
                if (typeof renderLiveStock === 'function') renderLiveStock();
                if (typeof renderLowStockAlert === 'function') renderLowStockAlert();
                break;
            case 'vastra_packs':
                if (typeof renderPackList === 'function') renderPackList();
                if (typeof renderLiveStock === 'function') renderLiveStock();
                if (typeof renderLowStockAlert === 'function') renderLowStockAlert();
                break;
            case 'vastra_customers':
                customers = JSON.parse(localStorage.getItem('vastra_customers') || '[]');
                if (typeof updateStats === 'function') updateStats();
                if (typeof renderCustomerSelectList === 'function') renderCustomerSelectList();
                break;
            case 'vastra_agents':
                agents = JSON.parse(localStorage.getItem('vastra_agents') || '[]');
                if (typeof renderAgentList === 'function') renderAgentList();
                break;
            case 'vastra_salesReturns':
                salesReturns = JSON.parse(localStorage.getItem('vastra_salesReturns') || '[]');
                if (typeof renderSRList === 'function') renderSRList();
                if (typeof renderLiveStock === 'function') renderLiveStock();
                if (typeof renderLowStockAlert === 'function') renderLowStockAlert();
                break;
            case 'vastra_invoices':
                if (typeof invoices !== 'undefined') invoices = JSON.parse(localStorage.getItem('vastra_invoices') || '[]');
                break;
            case 'vastra_categoryTypes':
                categoryTypes = JSON.parse(localStorage.getItem('vastra_categoryTypes') || '[]');
                if (typeof renderCategoryTypeList === 'function') renderCategoryTypeList();
                break;
            case 'vastra_role_permissions':
                if (typeof applyPermissions === 'function') applyPermissions();
                if (typeof renderPermissionsTable === 'function') renderPermissionsTable();
                break;
            case 'vastra_supplier':
                // Implicit refresh
                break;
        }
    } catch (e) {
        console.warn('UI refresh error for ' + key + ':', e);
    }
}

// ── Override localStorage.setItem ────────────────
const _originalSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function (key, value) {
    // 🧹 Aggressive cleanup to prevent QuotaExceededError
    let forceCloudSync = false;
    if (['vastra_challans', 'vastra_packs', 'vastra_invoices', 'vastra_salesReturns'].includes(key)) {
        try {
            const data = JSON.parse(value);
            let changed = false;
            if (Array.isArray(data)) {
                data.forEach(entry => {
                    if (entry && entry.items) {
                        entry.items.forEach(item => {
                            if (item.imgSrc && item.imgSrc.length > 50) {
                                delete item.imgSrc;
                                changed = true;
                            }
                        });
                    }
                });
            }
            if (changed) {
                value = JSON.stringify(data);
                forceCloudSync = true;
            }
        } catch (e) {
            console.warn('Interceptor JSON parse error:', e);
        }
    }

    _originalSetItem(key, value);

    if (SYNC_KEYS.includes(key)) {
        if (!_suppressFirebaseWrite || forceCloudSync) {
            // Mark key as pending: local is ahead of cloud.
            // Listener will skip cloud updates until Firebase push completes.
            _lastLocalJSON[key] = value;
            _pendingLocalKeys.add(key);
            syncToFirebase(key);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    firebaseInit();

    // Hook into VastraDB to automatically push designs to Firebase after saveAll
    if (typeof VastraDB !== 'undefined' && typeof VastraDB.saveAll === 'function') {
        const _origSaveAll = VastraDB.saveAll.bind(VastraDB);
        VastraDB.saveAll = async function (data) {
            const result = await _origSaveAll(data);
            if (!_suppressFirebaseWrite) {
                // Background sync
                window.syncDesignsToFirebaseManual();
            }
            return result;
        };
    }
});
  databaseURL: "https://market-38c56-default-rtdb.firebaseio.com",
  projectId: "market-38c56",
  storageBucket: "market-38c56.firebasestorage.app",
  messagingSenderId: "454864357330",
  appId: "1:454864357330:web:cff523c0e8e40c80b9ea0b",
  measurementId: "G-KTRFEHP30Z"
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}
const fbAuth = firebase.auth();
const fbDB = firebase.database();
const analytics = firebase.analytics();

// ── Data keys to sync ────────────────────────────
// Note: vastra_designs is handled specially via VastraDB
const SYNC_KEYS = [
    'vastra_challans',
    'vastra_packs',
    'vastra_customers',
    'vastra_agents',
    'vastra_invoices',
    'vastra_salesReturns',
    'vastra_categoryTypes',
    'vastra_role_permissions',
    'vastra_supplier'
];

// ── State ────────────────────────────────────────
let fbUserId = null;
let fbReady = false;
let fbConnected = false;
let _suppressFirebaseWrite = false; // prevent write loops
let _syncDebounceTimers = {};
let _lastLocalJSON = {};           // Cache to detect redundant writes
let _pendingLocalKeys = new Set(); // Keys with local writes not yet pushed to Firebase

// ── Status UI ────────────────────────────────────
function updateSyncStatus(status) {
    const el = document.getElementById('syncStatusIndicator');
    if (!el) return;
    
    switch(status) {
        case 'online':
            el.innerHTML = '<i class="fa fa-cloud" style="color:#4caf50"></i>';
            el.title = 'Connected to Cloud';
            break;
        case 'offline':
            el.innerHTML = '<i class="fa fa-cloud" style="color:#9e9e9e"></i>';
            el.title = 'Offline';
            break;
        case 'syncing':
            el.innerHTML = '<i class="fa fa-sync fa-spin" style="color:#0088cc"></i>';
            el.title = 'Syncing...';
            break;
    }
}

// ── Helpers ──────────────────────────────────────
function smartMerge(local, remote) {
    if (!remote) return local;
    if (!local) return remote;

    // For non-array objects (supplier, permissions)
    if (!Array.isArray(local) || !Array.isArray(remote)) {
        const localTs = local.updatedAt || 0;
        const remoteTs = remote.updatedAt || 0;
        // If both have timestamps: pick newest
        // If neither has timestamps OR local is newer: keep local
        if (remoteTs > localTs) return remote;
        return local; // Default: keep local (don't let stale cloud overwrite fresh local)
    }

    const map = new Map();
    // Add local items
    local.forEach(item => {
        if (item && item.id) map.set(item.id, item);
    });
    // Merge remote items
    remote.forEach(remoteItem => {
        if (!remoteItem || !remoteItem.id) return;
        const localItem = map.get(remoteItem.id);
        if (!localItem || (remoteItem.updatedAt || 0) >= (localItem.updatedAt || 0)) {
            map.set(remoteItem.id, remoteItem);
        }
    });

    return Array.from(map.values());
}

// ── Anonymous Auth ───────────────────────────────
function firebaseInit() {
    // Monitor connection
    fbDB.ref(".info/connected").on("value", (snap) => {
        fbConnected = (snap.val() === true);
        if (fbConnected) {
            console.log('🌐 Firebase Connected');
            updateSyncStatus('online');
        } else {
            console.log('🌐 Firebase Disconnected');
            updateSyncStatus('offline');
        }
    });

    fbAuth.signInAnonymously()
        .then(() => console.log('✅ Firebase Auth successful'))
        .catch(err => console.error('❌ Firebase Auth failed:', err));

    fbAuth.onAuthStateChanged((user) => {
        if (user) {
            fbUserId = user.uid;
            fbReady = true;
            console.log('🔑 Firebase Ready:', fbUserId);
            startFirebaseListeners();
            // Initial sync: fetch everything first
            SYNC_KEYS.forEach(key => pullAndMerge(key));
            pullAndMergeDesigns();
            startDeepSyncPoller();
        } else {
            fbUserId = null;
            fbReady = false;
        }
    });
}

// ── Pull and Merge ───────────────────────────────
async function pullAndMerge(key) {
    if (!fbReady) return;
    updateSyncStatus('syncing');
    const ref = fbDB.ref(`vastra_shared_data/${key}`);
    ref.once('value').then(snapshot => {
        const fbData = snapshot.val();
        if (!fbData) {
            updateSyncStatus('online');
            return;
        }

        const localData = JSON.parse(localStorage.getItem(key) || (key.includes('supplier') || key.includes('permission') ? '{}' : '[]'));
        const merged = smartMerge(localData, fbData);

        const mergedJSON = JSON.stringify(merged);
        const localJSON = JSON.stringify(localData);
        _lastLocalJSON[key] = mergedJSON;
        
        if (mergedJSON !== localJSON) {
            _suppressFirebaseWrite = true;
            localStorage.setItem(key, mergedJSON);
            _suppressFirebaseWrite = false;
            console.log(`⬇️ Merged ${key} from Cloud`);
            if (typeof refreshUIForKey === 'function') refreshUIForKey(key);
            
            // Note: We don't need to push back here because the listener/transaction logic will handle it if needed
        }
        updateSyncStatus('online');
    });
}

async function pullAndMergeDesigns() {
    if (!fbReady || typeof VastraDB === 'undefined') return;
    updateSyncStatus('syncing');
    const ref = fbDB.ref(`vastra_shared_data/vastra_designs`);
    ref.once('value').then(async (snapshot) => {
        let fbData = snapshot.val();
        if (!fbData) {
            updateSyncStatus('online');
            return;
        }
        if (!Array.isArray(fbData) && typeof fbData === 'object') fbData = Object.values(fbData);

        const localDesigns = await VastraDB.getAll();
        const merged = smartMerge(localDesigns, fbData);
        // Sort merged designs numerically
        merged.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
        const mergedJSON = JSON.stringify(merged);
        _lastLocalJSON['vastra_designs'] = mergedJSON;

        if (mergedJSON !== JSON.stringify(localDesigns)) {
            _suppressFirebaseWrite = true;
            await VastraDB.saveAll(merged);
            _suppressFirebaseWrite = false;
            console.log(`⬇️ Merged vastra_designs from Cloud`);
            if (typeof refreshUIForKey === 'function') refreshUIForKey('vastra_designs');

            // Push back merged result
            window.syncDesignsToFirebaseManual();
        }
        updateSyncStatus('online');
    });
}

// ── Real-time Listeners ──────────────────────────
function startFirebaseListeners() {
    if (!fbReady) return;

    SYNC_KEYS.forEach(key => {
        fbDB.ref(`vastra_shared_data/${key}`).on('value', (snapshot) => {
            // If we have a PENDING local write for this key (e.g. a delete not yet pushed
            // to Firebase), do NOT let the old cloud data overwrite our local change.
            if (_pendingLocalKeys.has(key)) {
                console.log(`⏳ Listener skipped for ${key} (local write pending)`);
                return;
            }
            const fbData = snapshot.val();
            const isObjKey = key.includes('supplier') || key.includes('permission');
            const localDataStr = localStorage.getItem(key) || (isObjKey ? '{}' : '[]');
            const fbDataStr = JSON.stringify(fbData || (isObjKey ? {} : []));

            // Authoritative Mirroring: If cloud data is different, adopt it entirely
            if (fbDataStr !== localDataStr) {
                _suppressFirebaseWrite = true;
                _originalSetItem(key, fbDataStr);   // use original to avoid re-triggering
                _suppressFirebaseWrite = false;
                console.log(`✨ Automatic Sync (Mirror): ${key}`);
                if (typeof refreshUIForKey === 'function') refreshUIForKey(key);
            }
        });
    });

    fbDB.ref(`vastra_shared_data/vastra_designs`).on('value', async (snapshot) => {
        // NOTE: Do NOT block on _suppressFirebaseWrite here (same reason as above).
        if (typeof VastraDB === 'undefined') return;
        let fbData = snapshot.val();
        if (!fbData) fbData = []; // Handle empty deletion
        if (!Array.isArray(fbData) && typeof fbData === 'object') fbData = Object.values(fbData);

        try {
            const fbDataStr = JSON.stringify(fbData);
            // Skip if matches last known synced state
            if (fbDataStr === _lastLocalJSON['vastra_designs']) return;

            const localDesigns = await VastraDB.getAll();
            const localDataStr = JSON.stringify(localDesigns);

            // Authoritative Mirroring for Designs (IndexedDB)
            if (fbDataStr !== localDataStr) {
                _suppressFirebaseWrite = true;
                _lastLocalJSON['vastra_designs'] = fbDataStr;
                await VastraDB.saveAll(fbData);
                _suppressFirebaseWrite = false;
                console.log(`✨ Automatic Sync (Mirror): vastra_designs`);
                if (typeof refreshUIForKey === 'function') refreshUIForKey('vastra_designs');
            }
        } catch (e) {
            _suppressFirebaseWrite = false; // ensure reset on error
            console.error("Listener vastra_designs error:", e);
        }
    });
}

// ── Transactional Sync ──────────────────────────
function syncToFirebase(key) {
    if (!fbReady || _suppressFirebaseWrite) return;

    clearTimeout(_syncDebounceTimers[key]);
    _syncDebounceTimers[key] = setTimeout(() => {
        const localDataRaw = localStorage.getItem(key);
        if (!localDataRaw) return;

        const localData = JSON.parse(localDataRaw);
        updateSyncStatus('syncing');

        // AUTHORITATIVE PUSH: local is source of truth
        fbDB.ref(`vastra_shared_data/${key}`).set(localData, (error) => {
            if (error) {
                console.error(`Sync failed for ${key}:`, error);
            } else {
                _lastLocalJSON[key] = localDataRaw;
                _pendingLocalKeys.delete(key); // ✅ Push done — listener can now accept cloud
                console.log(`✅ ${key} synced to cloud (Authoritative)`);
            }
            updateSyncStatus('online');
        });
    }, 150);
}

window.syncDesignsToFirebaseManual = async function () {
    if (!fbReady || _suppressFirebaseWrite || typeof VastraDB === 'undefined') return;

    clearTimeout(_syncDebounceTimers['vastra_designs']);
    _syncDebounceTimers['vastra_designs'] = setTimeout(async () => {
        try {
            const localDesigns = await VastraDB.getAll();
            const localDataStr = JSON.stringify(localDesigns);
            
            if (localDataStr === _lastLocalJSON['vastra_designs']) return;

            updateSyncStatus('syncing');
            
            // AUTHORITATIVE PUSH: IndexedDB Designs to Firebase
            fbDB.ref(`vastra_shared_data/vastra_designs`).set(localDesigns, (error) => {
                if (error) {
                    console.error('Design sync failed:', error);
                } else {
                    _lastLocalJSON['vastra_designs'] = localDataStr;
                    console.log('✅ designs synced to cloud');
                }
                updateSyncStatus('online');
            });
        } catch (e) {
            console.error("Manual sync designs error:", e);
        }
    }, 150);
}

// ── Background Deep Sync (Every 10s) ──────────────
// This ensures that even if a websocket event was missed, data is 100% consistent across devices.
function startDeepSyncPoller() {
    setInterval(() => {
        if (!fbReady || !fbConnected) return;
        console.log('🔄 Deep Sync: Verifying consistency...');
        SYNC_KEYS.forEach(key => pullAndMerge(key));
        pullAndMergeDesigns();
    }, 10000); // 10 second goal
}

// ── UI Refresh ───────────────────────────────────
function refreshUIForKey(key) {
    try {
        switch (key) {
            case 'vastra_designs':
                if (typeof VastraDB !== 'undefined') {
                    VastraDB.getAll().then(res => {
                        // Sort designs numerically
                        designs = res.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), undefined, { numeric: true, sensitivity: 'base' }));
                        if (typeof renderDesignsTable === 'function') renderDesignsTable();
                        if (typeof updateStats === 'function') updateStats();
                    });
                }
                break;
            case 'vastra_challans':
                challans = JSON.parse(localStorage.getItem('vastra_challans') || '[]');
                if (typeof renderChallanList === 'function') renderChallanList();
                if (typeof updateStats === 'function') updateStats();
                // Refresh detail if open
                if (typeof currentDetailChallan !== 'undefined' && currentDetailChallan && typeof renderChallanDetail === 'function') {
                    const fresh = challans.find(c => c.id === currentDetailChallan.id);
                    if (fresh) renderChallanDetail(fresh);
                }
                // Refresh stock views
                if (typeof renderLiveStock === 'function') renderLiveStock();
                if (typeof renderLowStockAlert === 'function') renderLowStockAlert();
                break;
            case 'vastra_packs':
                if (typeof renderPackList === 'function') renderPackList();
                if (typeof renderLiveStock === 'function') renderLiveStock();
                if (typeof renderLowStockAlert === 'function') renderLowStockAlert();
                break;
            case 'vastra_customers':
                customers = JSON.parse(localStorage.getItem('vastra_customers') || '[]');
                if (typeof updateStats === 'function') updateStats();
                if (typeof renderCustomerSelectList === 'function') renderCustomerSelectList();
                break;
            case 'vastra_agents':
                agents = JSON.parse(localStorage.getItem('vastra_agents') || '[]');
                if (typeof renderAgentList === 'function') renderAgentList();
                break;
            case 'vastra_salesReturns':
                salesReturns = JSON.parse(localStorage.getItem('vastra_salesReturns') || '[]');
                if (typeof renderSRList === 'function') renderSRList();
                if (typeof renderLiveStock === 'function') renderLiveStock();
                if (typeof renderLowStockAlert === 'function') renderLowStockAlert();
                break;
            case 'vastra_invoices':
                if (typeof invoices !== 'undefined') invoices = JSON.parse(localStorage.getItem('vastra_invoices') || '[]');
                break;
            case 'vastra_categoryTypes':
                categoryTypes = JSON.parse(localStorage.getItem('vastra_categoryTypes') || '[]');
                if (typeof renderCategoryTypeList === 'function') renderCategoryTypeList();
                break;
            case 'vastra_role_permissions':
                if (typeof applyPermissions === 'function') applyPermissions();
                if (typeof renderPermissionsTable === 'function') renderPermissionsTable();
                break;
            case 'vastra_supplier':
                // Implicit refresh
                break;
        }
    } catch (e) {
        console.warn('UI refresh error for ' + key + ':', e);
    }
}

// ── Override localStorage.setItem ────────────────
const _originalSetItem = localStorage.setItem.bind(localStorage);
localStorage.setItem = function (key, value) {
    _originalSetItem(key, value);

    if (SYNC_KEYS.includes(key)) {
        if (!_suppressFirebaseWrite) {
            // Mark key as pending: local is ahead of cloud.
            // Listener will skip cloud updates until Firebase push completes.
            _lastLocalJSON[key] = value;
            _pendingLocalKeys.add(key);
            syncToFirebase(key);
        }
    }
};

document.addEventListener('DOMContentLoaded', () => {
    firebaseInit();

    // Hook into VastraDB to automatically push designs to Firebase after saveAll
    if (typeof VastraDB !== 'undefined' && typeof VastraDB.saveAll === 'function') {
        const _origSaveAll = VastraDB.saveAll.bind(VastraDB);
        VastraDB.saveAll = async function (data) {
            const result = await _origSaveAll(data);
            if (!_suppressFirebaseWrite) {
                // Background sync
                window.syncDesignsToFirebaseManual();
            }
            return result;
        };
    }
});
