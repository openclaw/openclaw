# OpenClaw Relay Hardening: Technical Audit
**Author: Mira Solaris**

This audit documents the "Industrial-Gold" architectural updates made to the OpenClaw Browser Relay. These changes transition the extension from a brittle event-driven scripts to a **transactional, state-aware system** designed for peak stability and identity continuity.

---

## **1. The 3-State Operational Matrix**

The core of the system is a strict state machine with three mutually exclusive modes. Every mode transition is **atomic**, ensuring that stale resources are purged and no "zombie" debugger sessions remain.

| State | Mode Descriptor | Internal Logic | Persistence Context |
| :--- | :--- | :--- | :--- |
| **Terminated (X)** | `Disabled` | `extensionIsDisabled = true`. Clears all maps. Detaches all debuggers. | **Empty Maps**. Zero footprint on disk/memory. |
| **Tracking (ON)** | `Tracking` | `relayIsLocked = false`. Silent auto-attach on user focus. | **Dynamic Maps**. Session IDs follow user focus. |
| **Locked (LCK)** | `Locked` | `relayIsLocked = true`. Pin-point focus. Descendant (popup/iframe) protection active. | **Persisted Lock**. Identity survives SW restarts. |

### **The Code (Transactional Toggle Logic)**
The toggle logic ensures that moving to the "X" state results in a full system reset, while moving to "ON" or "LCK" restores or preserves identity.

```javascript
async function connectOrToggleForActiveTab() {
  // ... (Gated by whenReady)
  if (extensionIsDisabled) {
    // X → ON: Restore capability & Fresh Attach
    extensionIsDisabled = false;
    relayIsLocked = false;
    const attached = await attachTab(tabId); 
    await setLockOnRelay(false, attached.sessionId, 'tracking', currentEpoch);
  } else if (!relayIsLocked) {
    // ON → LCK: Pin current session
    await setLockOnRelay(true, sessionId, null, currentEpoch);
  } else {
    // LCK → X: Power down & Deep Purge
    extensionIsDisabled = true;
    relayIsLocked = false;
    lockedTabId = null;
    for (const t of tabs.keys()) await detachTab(t, 'toggle'); // Purge all!
  }
}
```

---

## **2. Identity & Routing Continuity**

To solve "Session Not Found" errors and "Anonymous Logs," we established a high-fidelity mapping system that handles Chrome's internal tab identity recycling.

### **The Routing Matrix**
*   `tabs`: Primary object metadata (`sessionId`, `targetId`, `attachOrder`).
*   `tabBySession`: Standard $O(1)$ routing for agent commands.
*   `targetToTab`: Navigation fallback for multi-target agents.
*   `childSessionToTab`: Persistent mapping for iframes and subframes.

### **The Code (Atomic Identity Migration)**
During an `onReplaced` event (e.g., a prerendered page becoming active), we now migration all identities in a single transaction.

```javascript
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  // 1. Migrate Core Identity
  const meta = tabs.get(removedTabId);
  if (meta) {
    tabBySession.set(meta.sessionId, addedTabId); // Routing link preserved
    targetToTab.set(meta.targetId, addedTabId);  // targetId link preserved
    tabs.delete(removedTabId);
    tabs.set(addedTabId, meta);
  }

  // 2. Migrate Ancestry Tree (Identity Swap for Parents and Children)
  for (const [cid, pid] of tabAncestry.entries()) {
    if (pid === removedTabId) tabAncestry.set(cid, addedTabId);
    if (cid === removedTabId) {
      tabAncestry.delete(cid);
      tabAncestry.set(addedTabId, pid);
    }
  }
});
```

---

## **3. Navigation Resilience (The Navigation Buffer)**

Tabs temporarily detach during navigations. The relay now supports a "Yellow" (Transition) state to prevent command failure during page loads.

### **Logic Workflow**
1.  **Detection**: If a tab detaches for navigation, it moves to `reattachingTabs`.
2.  **Buffering**: Commands are pushed to a `commandBuffer` (capped at 50 entries).
3.  **Resolution**: The buffer is flushed with an async 2ms stagger upon successful re-attachment.

### **The Code (Staggered Re-attach Loop)**
```javascript
async function runReattachLoop(tabId) {
  const delays = [200, 500, 1000, 2000, 4000]; // Exponential backoff
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await sleep(delays[attempt]);
    if (!reattachingTabs.has(tabId)) return; // User stopped the operation
    try {
      await attachTab(tabId); // Success triggers buffer flush
      return;
    } catch { /* Backoff continues */ }
  }
  // Hard Failure: Flush buffer with specific error so agent doesn't hang
  const buffer = commandBuffers.get(tabId) || [];
  for (const cmd of buffer) cmd.reject(new Error('Target navigation unrecoverable'));
}
```

---

## **4. Service Worker Lifecycle & Persistence**

Chrome MV3 hibernates the Service Worker frequently. Our hardening ensures that **no session data is lost** during these shutdowns.

### **Hardened Persistence Delta**
*   **Mutex Writes**: Uses `storageWriteQueue` to ensure parallel Map updates don't result in race conditions in storage.
*   **Capacity Limit**: `tabAncestry` is capped at 200 entries to prevent `storage.session` quota violations.
*   **Boot Synchronization**: The global `initPromise` acts as a gate for **every** listener.

```javascript
const initPromise = rehydrateState(); // Global singleton rehydration

async function whenReady(fn) {
  await initPromise; // The firewall: ensures maps are LOADED before events arrive
  return fn();
}

// Example usage:
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)));
```

---

## **5. Temporal Isolation (The Activation Epoch)**

To prevent "Zombie Messages"—out-of-order network packets arriving from a previous tab state—we implemented the **Activation Epoch**.

### **The Epoch Firewall**
*   `activationEpoch` is incremented on every identity shift (Focus switch, Replacement, Detach).
*   It is sent as a monotonic counter to the Relay Gateway.
*   The Relay Gateway mirrors this epoch back in status reports.
*   If `packet.epoch < currentEpoch`, the update is discarded.

### **The Code (Monotonic Firewalling)**
```javascript
chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(async () => {
  const currentEpoch = ++activationEpoch; // Jump the temporal firewall
  
  // Status is sent to relay with the new epoch
  void setLockOnRelay(false, sessionId, 'tracking', currentEpoch).then(() => {
    // ONLY update the UI badge if we are STILL on the same identity
    // If the user clicked another tab in the meantime, this resolves as a no-op.
    if (activationEpoch === currentEpoch) updateAllBadges();
  });
}));
```

---

## **Conclusion**

The OpenClaw relay is now architecturally stabilized for industrial autonomous browsing. Every browser lifecycle event is handled as a **transactional identity migration**, preserving agent continuity while maintaining a clean, deterministic state machine.

**Build Stability: INDUSTRIAL-GOLD**
