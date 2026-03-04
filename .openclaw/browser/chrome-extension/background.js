import { buildRelayWsUrl, deriveRelayToken, isRetryableReconnectError, reconnectDelayMs } from './background-utils.js'

const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: 'X', color: '#7F1D1D' },
  locked: { text: 'LCK', color: '#10B981' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null
let relayGatewayToken = ''
let relayConnectRequestId = null
let relayIsLocked = false
let lockedTabId = null
let extensionIsDisabled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// Per-tab operation locks prevent double-attach races.
/** @type {Set<number>} */
const tabOperationLocks = new Set()

// Tabs currently in a detach/re-attach cycle after navigation.
/** @type {Set<number>} */
const reattachPending = new Set()

// Reconnect state for exponential backoff.
let reconnectAttempt = 0
let reconnectTimer = null

// Track which tab currently has the floating overlay so we can remove it when switching.
/** @type {number|null} */
let lastOverlayTabId = null

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

async function getRelayPort() {
  const stored = await chrome.storage.local.get(['relayPort'])
  const raw = stored.relayPort
  const n = Number.parseInt(String(raw || ''), 10)
  if (!Number.isFinite(n) || n <= 0 || n > 65535) return DEFAULT_PORT
  return n
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(['gatewayToken'])
  const token = String(stored.gatewayToken || '').trim()
  return token || ''
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  const opts = tabId ? { tabId, text: cfg.text } : { text: cfg.text }
  const bgOpts = tabId ? { tabId, color: cfg.color } : { color: cfg.color }
  const fgOpts = tabId ? { tabId, color: '#FFFFFF' } : { color: '#FFFFFF' }
  void chrome.action.setBadgeText(opts)
  void chrome.action.setBadgeBackgroundColor(bgOpts)
  void chrome.action.setBadgeTextColor(fgOpts).catch(() => {})
}

// Persist attached tab state to survive MV3 service worker restarts.
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if ((tab.state === 'connected' || tab.state === 'disabled') && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder, state: tab.state })
      }
    }
    await chrome.storage.session.set({
      persistedTabs: tabEntries,
      nextSession,
      lockedTabId,
      extensionIsDisabled,
    })
  } catch {
    // chrome.storage.session may not be available in all contexts.
  }
}

// Rehydrate tab state on service worker startup. Fast path — just restores
// maps and badges. Relay reconnect happens separately in background.
/**
 * Computes and sets the badges exactly how the states require:
 * - Locked: Green only on locked tab, others blank.
 * - Orange: Orange on ALL tabs globally.
 * - X: X on ALL tabs globally.
 */
function updateAllBadges() {
  const isUp = !!(relayWs && relayWs.readyState === WebSocket.OPEN)
  
  if (!extensionIsDisabled && tabs.size === 0) {
    extensionIsDisabled = true;
    void persistState();
  }
  
  let globalKind = 'error';
  if (extensionIsDisabled) {
    globalKind = 'error';
  } else if (relayIsLocked) {
    globalKind = 'off';
  } else if (isUp && tabs.size > 0 && Array.from(tabs.values()).some(t => t.state === 'connected')) {
    globalKind = 'on';
  } else {
    extensionIsDisabled = true;
    globalKind = 'error';
  }

  // Set the global default badge
  setBadge(null, globalKind);
  
  // Explicitly force every single tab's local override to match the new state,
  // resolving any ghosting issues from detached tabs
  chrome.tabs.query({}).then((allTabs) => {
    for (const tab of allTabs) {
      if (!tab.id) continue;
      
      if (relayIsLocked && lockedTabId === tab.id) {
        setBadge(tab.id, 'locked');
      } else {
        setBadge(tab.id, globalKind);
      }
    }
  }).catch(() => {});
  
  void syncAllOverlays()
}

/**
 * Permanently removes the floating status bar on a single tab using executeScript / debugger.
 * Called automatically to clean up any old labels that might still exist.
 */
async function setOverlayOnTab(tabId) {
  const removeFunc = () => {
    ['__openclawOverlay', '__openclawLockedIcon'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
    document.querySelectorAll('div').forEach(div => {
      if (div.textContent && div.textContent.includes('OpenClaw') && 
          div.style.position === 'fixed' && 
          (div.style.bottom === '10px' || div.style.right === '10px')) {
        div.remove();
      }
    });
  }
  
  await Promise.allSettled([
    chrome.scripting.executeScript({ target: { tabId }, func: removeFunc }).catch(() => {}),
    chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
      expression: `(${removeFunc.toString()})()`,
    }).catch(() => {})
  ]);
}

/**
 * Removes labels from ALL tabs. Labels are no longer supported.
 */
async function syncAllOverlays() {
  const allTabs = await chrome.tabs.query({});
  for (const tab of allTabs) {
    if (tab.id) setOverlayOnTab(tab.id).catch(() => {});
  }
}

async function rehydrateState() {
  try {
    const stored = await chrome.storage.session.get(['persistedTabs', 'nextSession', 'lockedTabId', 'extensionIsDisabled'])
    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession)
    }
    if (stored.lockedTabId) {
      lockedTabId = stored.lockedTabId
    }
    if (stored.extensionIsDisabled !== undefined) {
      extensionIsDisabled = stored.extensionIsDisabled
    }
    
    if (extensionIsDisabled) {
      setBadge(null, 'error')
    } else {
      setBadge(null, 'off')
    }
    
    const entries = stored.persistedTabs || []
    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      tabs.set(entry.tabId, {
        state: entry.state || 'connected',
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      })
      tabBySession.set(entry.sessionId, entry.tabId)
    }
    updateAllBadges()
    // Phase 2: validate asynchronously, remove dead tabs.
    for (const entry of entries) {
      try {
        await chrome.tabs.get(entry.tabId)
        await chrome.debugger.sendCommand({ tabId: entry.tabId }, 'Runtime.evaluate', {
          expression: '1',
          returnByValue: true,
        })
      } catch {
        tabs.delete(entry.tabId)
        tabBySession.delete(entry.sessionId)
        setBadge(entry.tabId, 'off')
      }
    }
  } catch {
    // Ignore rehydration errors.
  }
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const gatewayToken = await getGatewayToken()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = await buildRelayWsUrl(port, gatewayToken)

    // Fast preflight: is the relay server up?
    try {
      const resp = await fetch(`${httpBase}/extension/status`, { signal: AbortSignal.timeout(2000) })
      if (resp.ok) {
        const data = await resp.json().catch(() => ({}))
        relayIsLocked = !!data.lockTab
        console.log('[OpenClaw] Fetched relay status. lockTab:', relayIsLocked)
      } else {
        console.warn('[OpenClaw] Relay status fetch failed:', resp.status)
      }
    } catch (err) {
      console.warn('[OpenClaw] Relay status fetch exception:', err)
      // Don't throw here; let WebSocket attempt to connect anyway
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws
    relayGatewayToken = gatewayToken
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (ws !== relayWs) return
      void whenReady(() => onRelayMessage(String(event.data || '')))
    }

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('WebSocket connect timeout')), 5000)
      ws.onopen = () => {
        clearTimeout(t)
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    // Bind permanent handlers. Guard against stale socket: if this WS was
    // replaced before its close fires, the handler is a no-op.
    ws.onclose = () => {
      if (ws !== relayWs) return
      onRelayClosed('closed')
    }
    ws.onerror = () => {
      if (ws !== relayWs) return
      onRelayClosed('error')
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
    updateAllBadges()
  } finally {
    relayConnectPromise = null
  }
}

/**
 * Toggle the lockTab setting on the relay server.
 * @param {boolean} locked
 * @returns {Promise<{ok:boolean, lockTab:boolean}|null>}
 */
async function setLockOnRelay(locked, tabId = null) {
  const port = await getRelayPort()
  const gatewayToken = await getGatewayToken()
  const relayToken = await deriveRelayToken(gatewayToken, port)
  try {
    const resp = await fetch(`http://127.0.0.1:${port}/extension/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-openclaw-relay-token': relayToken,
      },
      body: JSON.stringify({ lockTab: locked }),
      signal: AbortSignal.timeout(3000),
    })
    if (resp.ok) {
      const data = await resp.json()
      relayIsLocked = !!data.lockTab
      
      if (relayIsLocked) {
        lockedTabId = tabId
      } else if (lockedTabId === tabId || tabId === null) {
        lockedTabId = null
      }
      
      void persistState()
      return data
    }
    return null
  } catch (err) {
    console.warn('[OpenClaw] setLockOnRelay failed:', err)
    return null
  }
}

// Relay closed — update badges, reject pending requests, auto-reconnect.
// Debugger sessions are kept alive so they survive transient WS drops.
function onRelayClosed(reason) {
  relayWs = null
  relayGatewayToken = ''
  relayConnectRequestId = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  reattachPending.clear()

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      })
    }
  }

  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }

  const delay = reconnectDelayMs(reconnectAttempt)
  reconnectAttempt++

  console.log(`Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    try {
      await ensureRelayConnection()
      reconnectAttempt = 0
      console.log('Reconnected successfully')
      await reannounceAttachedTabs()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`Reconnect attempt ${reconnectAttempt} failed: ${message}`)
      if (!isRetryableReconnectError(err)) {
        return
      }
      scheduleReconnect()
    }
  }, delay)
}

function cancelReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
}

// Re-announce all attached tabs to the relay after reconnect.
async function reannounceAttachedTabs() {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected' || !tab.sessionId || !tab.targetId) continue

    // Verify debugger is still attached.
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      })
    } catch {
      tabs.delete(tabId)
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach/detach)',
      })
      continue
    }

    // Send fresh attach event to relay.
    // Split into two try-catch blocks so debugger failures and relay send
    // failures are handled independently. Previously, a relay send failure
    // would fall into the outer catch and set the badge to 'on' even though
    // the relay had no record of the tab — causing every subsequent browser
    // tool call to fail with "no tab connected" until the next reconnect cycle.
    let targetInfo
    try {
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      targetInfo = info?.targetInfo
    } catch {
      // Target.getTargetInfo failed. Preserve at least targetId from
      // cached tab state so relay receives a stable identifier.
      targetInfo = tab.targetId ? { targetId: tab.targetId } : undefined
    }

    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId: tab.sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })

      setBadge(tabId, relayIsLocked ? 'locked' : 'on')
      void chrome.action.setTitle({
        tabId,
        title: relayIsLocked ? 'OpenClaw Browser Relay: LOCKED to this tab (click to detach)' : 'OpenClaw Browser Relay: attached (click to detach)',
      })
    } catch {
      // Relay send failed (e.g. WS closed in the gap between ensureRelayConnection
      // resolving and this loop executing). The tab is still valid — leave badge
      // as 'connecting' so the reconnect/keepalive cycle will retry rather than
      // showing a false-positive 'on' that hides the broken state from the user.
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay reconnecting…',
      })
    }
  }

  await persistState()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  sendToRelay({
    type: 'req',
    id: relayConnectRequestId,
    method: 'connect',
    params: {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'chrome-relay-extension',
        version: '1.0.0',
        platform: 'chrome-extension',
        mode: 'webchat',
      },
      role: 'operator',
      scopes: ['operator.read', 'operator.write'],
      caps: [],
      commands: [],
      nonce: nonce || undefined,
      auth: relayGatewayToken ? { token: relayGatewayToken } : undefined,
    },
  })
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('Relay request timeout (30s)'))
    }, 30000)
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v) },
      reject: (e) => { clearTimeout(timer); reject(e) },
    })
    try {
      sendToRelay(command)
    } catch (err) {
      clearTimeout(timer)
      pending.delete(id)
      reject(err instanceof Error ? err : new Error(String(err)))
    }
  })
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.type === 'event' && msg.event === 'connect.challenge') {
    try {
      ensureGatewayHandshakeStarted(msg.payload)
    } catch (err) {
      console.warn('gateway connect handshake start failed', err instanceof Error ? err.message : String(err))
      relayConnectRequestId = null
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.type === 'res' && relayConnectRequestId && msg.id === relayConnectRequestId) {
    relayConnectRequestId = null
    if (!msg.ok) {
      const detail = msg?.error?.message || msg?.error || 'gateway connect failed'
      console.warn('gateway connect handshake rejected', String(detail))
      const ws = relayWs
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close(1008, 'gateway connect failed')
      }
    }
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && (msg.result !== undefined || msg.error !== undefined)) {
    const p = pending.get(msg.id)
    if (!p) return
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(String(msg.error)))
    else p.resolve(msg.result)
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) })
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const sid = nextSession++
  const sessionId = `cb-tab-${sid}`
  const attachOrder = sid

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: relayIsLocked
      ? 'OpenClaw Browser Relay: LOCKED (click to lock/detach)'
      : 'OpenClaw Browser Relay: attached (click to lock/detach)',
  })

  // Overlay is synced after attach via syncAllOverlays()

  if (!opts.skipAttachedEvent) {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        method: 'Target.attachedToTarget',
        params: {
          sessionId,
          targetInfo: { ...targetInfo, attached: true },
          waitingForDebugger: false,
        },
      },
    })
  }

  setBadge(tabId, relayIsLocked ? 'locked' : 'on')
  await persistState()

  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)

  // Send detach events for child sessions first.
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.detachedFromTarget',
            params: { sessionId: childSessionId, reason: 'parent_detached' },
          },
        })
      } catch {
        // Relay may be down.
      }
      childSessionToTab.delete(childSessionId)
    }
  }

  // Send detach event for main session.
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // May already be detached.
  }

  // Sync overlays globally to remove label from the detached tab
  await syncAllOverlays()

  updateAllBadges() // Sync ALL badges (forcing the detached tab to correctly inherit the globally applied state)
  void chrome.action.setTitle({
    tabId,
    title: extensionIsDisabled ? 'OpenClaw Browser Relay: STOPPED globally (click to run)' : 'OpenClaw Browser Relay (click to attach)',
  })

  await persistState()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  // Prevent concurrent operations on the same tab.
  if (tabOperationLocks.has(tabId)) return
  tabOperationLocks.add(tabId)

  try {
    if (reattachPending.has(tabId)) {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach)',
      })
      return
    }

    const existing = tabs.get(tabId)

    if (extensionIsDisabled) {
      // X → ON: remove global disabled state, attach current tab
      extensionIsDisabled = false
      
      if (!existing || existing.state !== 'connected') {
        tabs.set(tabId, { state: 'connecting' })
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: connecting to local relay…' })
        
        try {
          await ensureRelayConnection()
          await attachTab(tabId)
          updateAllBadges()
          void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: attached (click to lock)' })
        } catch (err) {
          tabs.delete(tabId)
          setBadge(tabId, 'error')
          void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: relay not running (open options for setup)' })
          void maybeOpenHelpOnce()
          const message = err instanceof Error ? err.message : String(err)
          console.warn('attach failed', message, nowStack())
        }
      } else {
        updateAllBadges()
        void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: attached (click to lock)' })
      }
      return
    }

    // 3-state cycle (now we are in ON or LCK state)
    if (existing?.state === 'connected') {
      if (!relayIsLocked) {
        // ON → LCK: enable lock on relay
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: locking…' })
        const result = await setLockOnRelay(true, tabId)
        if (result) {
          updateAllBadges()
          void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: LOCKED (click to stop / X)' })
        } else {
          setBadge(tabId, 'on')
          void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: attached (click to lock)' })
        }
      } else {
        // LCK → X: unlock relay, set state to disabled globally
        await setLockOnRelay(false, tabId)
        extensionIsDisabled = true
        
        // Detach all tabs to fully stop taking commands and remove chrome infobar
        for (const t of Array.from(tabs.keys())) {
          await detachTab(t, 'toggle').catch(() => {})
        }
        
        updateAllBadges() // Everyone gets X
        void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: STOPPED globally (click to run)' })
      }
      return
    }

    // Fallback: idle tab while ON/LCK → ON (attach new tab)
    cancelReconnect()

    tabs.set(tabId, { state: 'connecting' })
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: connecting to local relay…',
    })

    try {
      await ensureRelayConnection()
      await attachTab(tabId)
      updateAllBadges()
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to lock)',
      })
    } catch (err) {
      tabs.delete(tabId)
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
      })
      void maybeOpenHelpOnce()
      const message = err instanceof Error ? err.message : String(err)
      console.warn('attach failed', message, nowStack())
    }
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

  if (extensionIsDisabled) {
    throw new Error('Extension is globally disabled. Commands from relay refused.')
  }

  if (!tabId) throw new Error(`No attached tab for method ${method}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const mainSessionId = tabs.get(tabId)?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // Relay may be down.
  }
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // User explicitly cancelled or DevTools replaced the connection — respect their intent
  if (reason === 'canceled_by_user' || reason === 'replaced_with_devtools') {
    void detachTab(tabId, reason)
    return
  }

  // Check if tab still exists — distinguishes navigation from tab close
  let tabInfo
  try {
    tabInfo = await chrome.tabs.get(tabId)
  } catch {
    // Tab is gone (closed) — normal cleanup
    void detachTab(tabId, reason)
    return
  }

  if (tabInfo.url?.startsWith('chrome://') || tabInfo.url?.startsWith('chrome-extension://')) {
    void detachTab(tabId, reason)
    return
  }

  if (reattachPending.has(tabId)) return

  const oldTab = tabs.get(tabId)
  const oldSessionId = oldTab?.sessionId
  const oldTargetId = oldTab?.targetId

  if (oldSessionId) tabBySession.delete(oldSessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  if (oldSessionId && oldTargetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: oldSessionId, targetId: oldTargetId, reason: 'navigation-reattach' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }

  reattachPending.add(tabId)
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attaching after navigation…',
  })

  // Extend re-attach window from 2.5 s to ~7.7 s (5 attempts).
  // SPAs and pages with heavy JS can take >2.5 s before the Chrome debugger
  // is attachable, causing all three original attempts to fail and leaving
  // the badge permanently off after every navigation.
  const delays = [200, 500, 1000, 2000, 4000]
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await new Promise((r) => setTimeout(r, delays[attempt]))

    if (!reattachPending.has(tabId)) return

    try {
      await chrome.tabs.get(tabId)
    } catch {
      reattachPending.delete(tabId)
      setBadge(tabId, 'off')
      return
    }

    const relayUp = relayWs && relayWs.readyState === WebSocket.OPEN

    try {
      // When relay is down, still attach the debugger but skip sending the
      // relay event. reannounceAttachedTabs() will notify the relay once it
      // reconnects, so the tab stays tracked across transient relay drops.
      await attachTab(tabId, { skipAttachedEvent: !relayUp })
      reattachPending.delete(tabId)
      if (!relayUp) {
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({
          tabId,
          title: 'OpenClaw Browser Relay: attached, waiting for relay reconnect…',
        })
      }
      return
    } catch {
      // continue retries
    }
  }

  reattachPending.delete(tabId)
  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: re-attach failed (click to retry)',
  })
}

// Tab lifecycle listeners — clean up stale entries.
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  reattachPending.delete(tabId)
  if (!tabs.has(tabId)) return
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason: 'tab_closed' },
        },
      })
    } catch {
      // Relay may be down.
    }
  }
  void persistState()
}))

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(() => {
  const tab = tabs.get(removedTabId)
  if (!tab) return
  tabs.delete(removedTabId)
  tabs.set(addedTabId, tab)
  if (tab.sessionId) {
    tabBySession.set(tab.sessionId, addedTabId)
  }
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === removedTabId) {
      childSessionToTab.set(childSessionId, addedTabId)
    }
  }
  updateAllBadges()
  void chrome.action.setTitle({
    tabId: addedTabId,
    title: relayIsLocked ? 'OpenClaw Browser Relay: LOCKED to this tab (click to detach)' : 'OpenClaw Browser Relay: attached (click to detach)',
  })
  void persistState()
}))

// Register debugger listeners at module scope so detach/event handling works
// even when the relay WebSocket is down.
chrome.debugger.onEvent.addListener((...args) => void whenReady(() => onDebuggerEvent(...args)))
chrome.debugger.onDetach.addListener((...args) => void whenReady(() => onDebuggerDetach(...args)))

chrome.action.onClicked.addListener(() => void whenReady(() => connectOrToggleForActiveTab()))

// Refresh badge + overlay after navigation completes.
chrome.webNavigation.onCompleted.addListener(({ tabId, frameId }) => void whenReady(async () => {
  if (frameId !== 0) return
  updateAllBadges()
  // Re-sync overlays after page load (DOM was reset by navigation)
  await syncAllOverlays()
}))

// When user switches tabs:
// Sync all overlays globally. The broadcast logic handles showing/hiding on correct tabs.
chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(async () => {
  updateAllBadges() // Ensure the newly activated tab has the correct badge set if local overriding applies
  await syncAllOverlays()
}))

chrome.runtime.onInstalled.addListener(() => {
  // Clear any stale overlays from a previous session on install/update
  void syncAllOverlays()
  void chrome.runtime.openOptionsPage()
})

// MV3 keepalive via chrome.alarms — more reliable than setInterval across
// service worker restarts. Checks relay health and refreshes badges.
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.5 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  await initPromise

  if (tabs.size === 0) return

  // Refresh badges (ephemeral in MV3).
  updateAllBadges()

  // If relay is down and no reconnect is in progress, trigger one.
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
    if (!relayConnectPromise && !reconnectTimer) {
      console.log('Keepalive: WebSocket unhealthy, triggering reconnect')
      await ensureRelayConnection().catch(() => {
        // ensureRelayConnection may throw without triggering onRelayClosed
        // (e.g. preflight fetch fails before WS is created), so ensure
        // reconnect is always scheduled on failure.
        if (!reconnectTimer) {
          scheduleReconnect()
        }
      })
    }
  }
})

// Rehydrate state on service worker startup. Split: rehydration is the gate
// (fast), relay reconnect runs in background (slow, non-blocking).
const initPromise = rehydrateState()

initPromise.then(() => {
  if (tabs.size > 0) {
    ensureRelayConnection().then(() => {
      reconnectAttempt = 0
      return reannounceAttachedTabs()
    }).catch(() => {
      scheduleReconnect()
    })
  }
})

// Shared gate: all state-dependent handlers await this before accessing maps.
async function whenReady(fn) {
  await initPromise
  return fn()
}

// Relay check handler for the options page. The service worker has
// host_permissions and bypasses CORS preflight, so the options page
// delegates token-validation requests here.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'relayCheck') {
    const { url, token } = msg
    const headers = token ? { 'x-openclaw-relay-token': token } : {}
    fetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(2000) })
      .then(async (res) => {
        const contentType = String(res.headers.get('content-type') || '')
        let json = null
        if (contentType.includes('application/json')) {
          try {
            json = await res.json()
          } catch {
            json = null
          }
        }
        sendResponse({ status: res.status, ok: res.ok, contentType, json })
      })
      .catch((err) => sendResponse({ status: 0, ok: false, error: String(err) }))
    return true
  }

  if (msg?.type === 'setLock') {
    const { locked } = msg
    void whenReady(async () => {
      // Find the currently active attached tab if we can't find one, default to null
      let activeTabId = null;
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
        activeTabId = active?.id || null
      } catch {}

      const result = await setLockOnRelay(!!locked, activeTabId)
      if (result) {
        updateAllBadges()
      }
      sendResponse({ ok: !!result, lockTab: relayIsLocked })
    })
    return true
  }

  if (msg?.type === 'getLockStatus') {
    sendResponse({ lockTab: relayIsLocked, connected: !!(relayWs && relayWs.readyState === WebSocket.OPEN) })
    return false
  }

  return false
})
