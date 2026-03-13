import {
  buildRelayWsUrl,
  deriveRelayToken,
  isLastRemainingTab,
  isMissingTabError,
  isRetryableReconnectError,
  reconnectDelayMs,
} from './background-utils.js'

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
let relayIsAuthenticated = false
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
/** @type {Map<number, {sessionId:string, targetId?:string, attachOrder:number, attempts?:number}>} */
const reattachingTabs = new Map()
/** @type {Map<string, number>} */
const targetToTab = new Map() // targetId -> tabId

// Reconnect state for exponential backoff.
let reconnectAttempt = 0
let reconnectTimer = null

// Monotonic counter to invalidate out-of-order network responses.
let activationEpoch = 0
/** @type {Map<number, number>} */
const tabAncestry = new Map() // childTabId -> parentTabId
/** @type {Set<number>} */
const pendingSwaps = new Set()
/** @type {Map<number, Array<{method:string, params:any, id:number}>>} */
const commandBuffers = new Map() // tabId -> list of pending commands during navigation
/** @type {string|null} */
let activeSocketGuid = null // GUID for the current active WebSocket session
// Rehydrate state on service worker startup. Rehydration is the gate (fast),
// relay reconnect runs in background (slow, non-blocking).
const initPromise = rehydrateState()

async function whenReady(fn) {
  await initPromise
  return fn()
}

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

const TAB_VALIDATION_ATTEMPTS = 2
const TAB_VALIDATION_RETRY_DELAY_MS = 1000


function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function validateAttachedTab(tabId) {
  try {
    await chrome.tabs.get(tabId)
  } catch {
    return false
  }

  for (let attempt = 0; attempt < TAB_VALIDATION_ATTEMPTS; attempt++) {
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '1',
        returnByValue: true,
      })
      return true
    } catch (err) {
      if (isMissingTabError(err)) {
        return false
      }
      if (attempt < TAB_VALIDATION_ATTEMPTS - 1) {
        await sleep(TAB_VALIDATION_RETRY_DELAY_MS)
      }
    }
  }

  return false
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

// Queue to serialize storage writes.
let storageWriteQueue = Promise.resolve()

// Persist attached tab state to survive MV3 service worker restarts.
async function persistState() {
  storageWriteQueue = storageWriteQueue.then(async () => {
    try {
      const tabEntries = []
      for (const [tabId, tab] of tabs.entries()) {
        if ((tab.state === 'connected' || tab.state === 'disabled') && tab.sessionId && tab.targetId) {
          tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder, state: tab.state })
        }
      }
      const reattachingEntries = Array.from(reattachingTabs.entries())
      const childSessionEntries = Array.from(childSessionToTab.entries())
      // Memory Safety: implement a sliding window for ancestry to avoid quota limits
      const ancestryEntries = Array.from(tabAncestry.entries()).slice(-200)
      
      await chrome.storage.session.set({
        persistedTabs: tabEntries,
        reattachingTabs: reattachingEntries,
        childSessionToTab: childSessionEntries,
        tabAncestry: ancestryEntries,
        nextSession,
        lockedTabId,
        relayIsLocked,
        extensionIsDisabled,
        activationEpoch,
      })
    } catch {
      // ignore
    }
  })
  return storageWriteQueue
}

// Rehydrate tab state on service worker startup. Fast path — just restores
// maps and badges. Relay reconnect happens separately in background.
/**
 * Computes and sets the badges exactly how the states require:
 * - Locked: Green only on locked tab, others blank.
 * - Orange: Orange on ALL tabs globally.
 * - X: X on ALL tabs globally.
 */
function updateActionTitle(tabId, kind) {
  let title = 'OpenClaw Browser Relay (click to run)'
  if (extensionIsDisabled) {
    title = 'OpenClaw Browser Relay: STOPPED globally (click to run)'
  } else if (kind === 'connecting') {
    title = 'OpenClaw Browser Relay: connecting to local relay…'
  } else if (relayIsLocked) {
    title = (tabId === lockedTabId) 
      ? 'OpenClaw Browser Relay: LOCKED (click to stop / X)' 
      : 'OpenClaw Browser Relay: locked to another tab (click to steal lock)'
  } else if (kind === 'on') {
    title = 'OpenClaw Browser Relay: attached and tracking (click to lock)'
  } else if (tabs.has(tabId)) {
    title = 'OpenClaw Browser Relay: attached (click to lock)'
  }
  void chrome.action.setTitle(tabId ? { tabId, title } : { title })
}



function updateAllBadges() {
  const isUp = !!(relayWs && relayWs.readyState === WebSocket.OPEN)
  
  let globalKind = 'off';
  if (extensionIsDisabled) {
    globalKind = 'error';
  } else if (!isUp) {
    globalKind = 'connecting';
  }

  // Set the global default badge and title
  setBadge(null, globalKind);
  updateActionTitle(null, globalKind);
  
  chrome.tabs.query({}).then((allTabs) => {
    for (const tab of allTabs) {
      if (!tab.id) continue;
      
      if (reattachingTabs.has(tab.id)) {
        setBadge(tab.id, 'connecting');
        updateActionTitle(tab.id, 'connecting')
      } else if (relayIsLocked && lockedTabId === tab.id) {
        setBadge(tab.id, 'locked');
        updateActionTitle(tab.id, 'locked')
      } else if (extensionIsDisabled) {
        setBadge(tab.id, 'error');
        updateActionTitle(tab.id, 'error')
      } else if (!isUp) {
        setBadge(tab.id, 'connecting');
        updateActionTitle(tab.id, 'connecting')
      } else if (tabs.has(tab.id)) {
        // If locked, attached tabs that are not the lock target remain blank.
        // Otherwise, they show the 'ON' tracking badge.
        const kind = relayIsLocked ? 'off' : 'on'
        setBadge(tab.id, kind);
        updateActionTitle(tab.id, kind)
      } else {
        // Default unattached state
        setBadge(tab.id, 'off');
        updateActionTitle(tab.id, 'off')
      }
    }
  }).catch(() => {});
}

/**
 * Permanently removes the floating status bar on a single tab using executeScript / debugger.
 * Called automatically to clean up any old labels that might still exist.
 */
async function setOverlayOnTab(tabId) {
  // Overlays/Labels are no longer supported to achieve O(1) performance.
  // This function is kept as a no-op to satisfy existing cleanup calls.
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
    const stored = await chrome.storage.session.get([
      'persistedTabs', 'reattachingTabs', 'childSessionToTab', 'tabAncestry',
      'nextSession', 'lockedTabId', 'relayIsLocked',
      'extensionIsDisabled', 'activationEpoch'
    ])
    
    // Reset Transient State: ensures zero deadlocks after SW hibernation
    pendingSwaps.clear()
    tabOperationLocks.clear()

    if (stored.nextSession) {
      nextSession = Math.max(nextSession, stored.nextSession)
    }
    if (stored.lockedTabId) {
      lockedTabId = stored.lockedTabId
    }
    if (stored.relayIsLocked !== undefined) {
      relayIsLocked = stored.relayIsLocked
    }
    if (stored.extensionIsDisabled !== undefined) {
      extensionIsDisabled = stored.extensionIsDisabled
    }
    if (stored.activationEpoch !== undefined) {
      activationEpoch = Number(stored.activationEpoch) + 1000 // Monotonic jump on boot
    }
    
    const ancestryEntries = stored.tabAncestry || []
    for (const [childId, parentId] of ancestryEntries) {
      tabAncestry.set(Number(childId), Number(parentId))
    }
    
    if (extensionIsDisabled) {
      setBadge(null, 'error')
    } else {
      setBadge(null, 'off')
    }
    
    const entries = stored.persistedTabs || []
    const reattachingEntries = stored.reattachingTabs || []
    for (const [tabId, info] of reattachingEntries) {
      reattachingTabs.set(Number(tabId), info)
    }

    const childSessionEntries = stored.childSessionToTab || []
    for (const [sid, tid] of childSessionEntries) {
      childSessionToTab.set(sid, Number(tid))
    }

    // Phase 1: optimistically restore state and badges.
    for (const entry of entries) {
      const tabId = Number(entry.tabId)
      if (isNaN(tabId)) continue
      tabs.set(tabId, {
        state: entry.state || 'connected',
        sessionId: entry.sessionId,
        targetId: entry.targetId,
        attachOrder: entry.attachOrder,
      })
      tabBySession.set(entry.sessionId, tabId)
      if (entry.targetId) targetToTab.set(entry.targetId, tabId)
    }
    updateAllBadges()
    // Phase 2: validate asynchronously, remove dead tabs.
    // Retry once so transient busy/navigation states do not permanently drop
    // a still-attached tab after a service worker restart.
    for (const entry of entries) {
      const valid = await validateAttachedTab(entry.tabId)
      if (!valid) {
        await detachTab(entry.tabId, 'rehydration_failed', 'Tab stale after restart')
      }
    }

    // Resume lost re-attachment loops directly to bypass transition guards
    for (const [tabId] of reattachingTabs) {
      void runReattachLoop(Number(tabId))
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
        if (relayIsLocked && !lockedTabId) {
          const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
          lockedTabId = (active?.id && tabs.has(active.id)) ? active.id : (Array.from(tabs.keys())[0] || null)
        }
        console.log('[OpenClaw] Fetched relay status. lockTab:', relayIsLocked)
      } else {
        console.warn('[OpenClaw] Relay status fetch failed:', resp.status)
      }
    } catch (err) {
      // If the status endpoint is completely unreachable the WS will also fail,
      // but throw early so the user sees a clear "relay not running" error.
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    const socketGuid = crypto.randomUUID()
    activeSocketGuid = socketGuid
    relayWs = ws
    relayGatewayToken = gatewayToken
    // Bind message handler before open so an immediate first frame (for example
    // gateway connect.challenge) cannot be missed.
    ws.onmessage = (event) => {
      if (activeSocketGuid !== socketGuid) return
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
      if (activeSocketGuid !== socketGuid) return
      onRelayClosed('closed')
    }
    ws.onerror = () => {
      if (activeSocketGuid !== socketGuid) return
      onRelayClosed('error')
    }
  })()

  try {
    await relayConnectPromise
    reconnectAttempt = 0
    activationEpoch += 5000 // Invalidate any stale network state from previous connections
    updateAllBadges()
  } finally {
    relayConnectPromise = null
  }
}

/**
 * Toggle the lockTab setting on the relay server.
 * @param {boolean} locked
 * @param {string|number|null} tabId
 * @param {string|null} tabMode
 * @param {number|null} epoch
 */
async function setLockOnRelay(locked, tabId = null, tabMode = null, epoch = null) {
  if (locked && !tabId && tabMode !== 'lock_forbidden') {
    console.warn('[OpenClaw] Refusing lock without an attached tab ID')
    return null
  }
  
  // If we are locking a tab, kill any background re-attach loops for OTHER tabs
  // to prevent them from stealing the lock back if they finish re-attaching later.
  if (locked && tabId) {
    const numericId = (typeof tabId === 'string') ? tabBySession.get(tabId) : tabId
    for (const tid of reattachingTabs.keys()) {
      if (tid !== numericId) reattachingTabs.delete(tid)
    }
  }

  console.log(`[OpenClaw] setLockOnRelay(locked=${locked}, tabId=${tabId}, tabMode=${tabMode}, epoch=${epoch || activationEpoch})`)
  try {
    const port = await getRelayPort()
    const gatewayToken = await getGatewayToken()
    const relayToken = await deriveRelayToken(gatewayToken, port)
    const body = { lockTab: locked, tabId, activationEpoch: epoch || activationEpoch }
    if (tabMode) body.tabMode = tabMode
    const resp = await fetch(`http://127.0.0.1:${port}/extension/status`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'x-openclaw-relay-token': relayToken,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    })
    if (resp.ok) {
      const data = await resp.json()
      relayIsLocked = !!data.lockTab
      
      if (relayIsLocked) {
        // Resolve session ID string (cb-tab-X) back to numeric tabId for badges
        lockedTabId = (typeof tabId === 'string') ? (tabBySession.get(tabId) || null) : tabId
      } else if (lockedTabId === (typeof tabId === 'string' ? tabBySession.get(tabId) : tabId) || tabId === null) {
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
  activeSocketGuid = null
  relayIsAuthenticated = false
  relayGatewayToken = ''
  relayConnectRequestId = null

  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  // Release all navigation buffers immediately
  for (const [tabId, buffer] of commandBuffers.entries()) {
    commandBuffers.delete(tabId)
    for (const cmd of buffer) {
      if (cmd.reject) cmd.reject(new Error('Relay disconnected while navigating'))
    }
  }

  updateAllBadges()
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

    // Retry once here as well; reconnect races can briefly make an otherwise
    // healthy tab look unavailable.
    const valid = await validateAttachedTab(tabId)
    if (!valid) {
      tabs.delete(tabId)
      if (tab.sessionId) tabBySession.delete(tab.sessionId)
      
      if (tabId === lockedTabId) {
        lockedTabId = null
        relayIsLocked = false
        void setLockOnRelay(false).catch(() => {})
      }
      
      setBadge(tabId, 'off')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay (click to attach/detach)',
      })
      continue
    }

    // Send fresh attach event to relay.
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
      setBadge(tabId, 'connecting') // Temporary state before re-announcement success
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
    } catch (err) {
      // ignore failures, keep badge as connecting
    }
  }

  updateAllBadges()
  await persistState()
  
  // If we just re-connected and were already in LOCK mode, tell relay again
  if (relayIsLocked && lockedTabId) {
    const tab = tabs.get(lockedTabId)
    if (tab?.sessionId) {
      await setLockOnRelay(true, tab.sessionId).catch(() => {})
    }
  }
}

function sendToRelay(payload, { silent = false } = {}) {
  if (!relayIsAuthenticated && payload.type !== 'req' && payload.method !== 'pong') {
    if (silent) return false
    return false // Muffle traffic until handshake completes
  }
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (silent) return false
    throw new Error('Relay not connected')
  }
  try {
    ws.send(JSON.stringify(payload))
    return true
  } catch (err) {
    if (silent) return false
    throw err
  }
}

function ensureGatewayHandshakeStarted(payload) {
  if (relayConnectRequestId) return
  const nonce = typeof payload?.nonce === 'string' ? payload.nonce.trim() : ''
  relayConnectRequestId = `ext-connect-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  try {
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
    }, { silent: true })
  } catch (err) {
    relayConnectRequestId = null
    console.warn('[OpenClaw] Handshake send failed:', err)
  }
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
    if (msg.ok) {
      relayIsAuthenticated = true
      console.log('[OpenClaw] Gateway handshake successful.')
      void reannounceAttachedTabs()
    } else {
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
      sendToRelay({ id: msg.id, result }, { silent: true })
    } catch (err) {
      sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) }, { silent: true })
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
  const active = targetToTab.get(targetId)
  if (active) return active
  
  // Search re-attaching pool so commands can be buffered for navigating targets
  for (const [tabId, info] of reattachingTabs.entries()) {
    if (info.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  
  // Reuse existing session identity if this is a navigation re-attach
  const reattachInfo = reattachingTabs.get(tabId)
  const sessionId = opts.sessionId || reattachInfo?.sessionId || `cb-tab-${nextSession++}`
  const attachOrder = opts.attachOrder || reattachInfo?.attachOrder || (nextSession - 1)

  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetId = info.targetInfo?.targetId || (await chrome.debugger.getTargets()).find(t => t.tabId === tabId)?.targetId
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }
  
  tabs.set(tabId, {
    state: 'connected',
    sessionId,
    targetId: targetId || `cb-target-${tabId}`,
    attachOrder,
  })

  // Keep the reattach marker until attach succeeds so retry loops survive
  // transient attach failures during navigation.
  if (reattachInfo) {
    reattachingTabs.delete(tabId)
  }
  
  if (targetId) targetToTab.set(targetId, tabId)
  tabBySession.set(sessionId, tabId)
  
  if (relayIsLocked && !lockedTabId) {
    lockedTabId = tabId
  }

  if (relayIsLocked && lockedTabId === tabId) {
    void setLockOnRelay(true, sessionId).catch(() => {})
  }

  if (!opts.skipAttachedEvent) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { ...info.targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    } catch {
      // ignore failures
    }
  }

  updateAllBadges() // Syncs badges and titles correctly for new state
  await persistState()

  // Flush any buffered commands for this tab
  const buffer = commandBuffers.get(tabId) || []
  if (buffer.length > 0) {
    commandBuffers.delete(tabId)
    // Stagger flushes to avoid protocol burst congestion
    for (const cmd of buffer) {
      void handleForwardCdpCommand(cmd).then(
        res => sendToRelay({ id: cmd.id, result: res }, { silent: true }),
        err => sendToRelay({ id: cmd.id, error: err instanceof Error ? err.message : String(err) }, { silent: true })
      )
      await sleep(2)
    }
  }

  return { sessionId, targetId }
}

async function detachTab(tabId, reason, displayError) {
  // 1. Atomic Snapshot: ensures idempotency by returning if identity is already gone.
  const meta = tabs.get(tabId) || reattachingTabs.get(tabId)
  const hasDanglingState = commandBuffers.has(tabId) || 
                           tabAncestry.has(tabId) || 
                           [...tabAncestry.values()].includes(tabId) ||
                           [...childSessionToTab.values()].includes(tabId)
  
  if (!meta && !hasDanglingState && lockedTabId !== tabId) return

  const wasAttached = tabs.has(tabId)
  const sessionId = meta?.sessionId
  const targetId = meta?.targetId

  // 2. Recursive Ancestry GC: Purge all direct and indirect descendants before clearing registries.
  const purgeAncestry = (id) => {
    for (const [cid, pid] of tabAncestry.entries()) {
      if (pid === id) {
        tabAncestry.delete(cid)
        purgeAncestry(cid)
      }
      if (cid === id) {
        tabAncestry.delete(cid)
      }
    }
  }
  purgeAncestry(tabId)

  // 3. Child Session Termination: Send detach events for all related iframes.
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
      } catch {}
      childSessionToTab.delete(childSessionId)
    }
  }

  // 4. Main Session Termination: Broadcast authoritative death event to relay.
  if (sessionId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId, targetId: targetId || undefined, reason },
        },
      })
    } catch {}
    tabBySession.delete(sessionId)
  }

  // 5. Registry Erasure
  if (targetId) targetToTab.delete(targetId)
  tabs.delete(tabId)
  reattachingTabs.delete(tabId)

  // 6. Command Buffer Flushing: specific rejection reasons for the agent.
  const buffer = commandBuffers.get(tabId)
  if (buffer) {
    commandBuffers.delete(tabId)
    for (const cmd of buffer) {
      if (cmd.reject) cmd.reject(new Error(displayError || 'Target detached'))
    }
  }

  // 7. Lock Recovery
  if (lockedTabId === tabId) {
    lockedTabId = null
    relayIsLocked = false
    void setLockOnRelay(false).catch(() => {})
  }

  // 8. CDP Cleanup: only detach if we were actually attached (avoids log noise for navigating tabs).
  if (wasAttached) {
    try {
      await chrome.debugger.detach({ tabId })
    } catch {}
  }

  // 9. Industrial State Sync
  await syncAllOverlays().catch(() => {})
  updateAllBadges()
  void persistState()
}


async function connectOrToggleForActiveTab() {
  await whenReady(async () => {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabId = active?.id
    if (!tabId) return

    // Prevent concurrent operations on the same tab.
    if (tabOperationLocks.has(tabId)) return
    tabOperationLocks.add(tabId)

    try {
      if (reattachingTabs.has(tabId)) {
        reattachingTabs.delete(tabId)
        setBadge(tabId, 'off')
        return
      }

      // Gate manual toggle to prevent it from sending stale status updates.
      activationEpoch += 1000 // Invalidate any in-flight activated updates
      const currentEpoch = activationEpoch

    const existing = tabs.get(tabId)

    if (extensionIsDisabled) {
      // X → ON: remove global disabled state, attach current tab
      extensionIsDisabled = false
      relayIsLocked = false
      
      const sessionId = existing?.sessionId || null
      if (!existing || existing.state !== 'connected') {
        tabs.set(tabId, { state: 'connecting' })
        setBadge(tabId, 'connecting')
        void chrome.action.setTitle({ tabId, title: 'OpenClaw Browser Relay: connecting to local relay…' })
        
        try {
          await ensureRelayConnection()
          const attached = await attachTab(tabId)
          await setLockOnRelay(false, attached.sessionId, 'tracking', currentEpoch)
          updateAllBadges()
        } catch (err) {
          extensionIsDisabled = true
          tabs.delete(tabId)
          updateAllBadges()
          void maybeOpenHelpOnce()
        }
      } else {
        await setLockOnRelay(false, sessionId, 'tracking', currentEpoch)
        updateAllBadges()
      }
      return
    }

    // Currently RUNNING (Tracking) or LOCKED
    const sessionId = existing?.sessionId || null
    if (!relayIsLocked) {
      // ON → LCK: lock to current tab
      if (!existing || existing.state !== 'connected') {
        // Automatically attach if user clicks an idle tab while in RUN mode to lock it
        const attached = await attachTab(tabId)
        await setLockOnRelay(true, attached.sessionId, null, currentEpoch)
      } else {
        await setLockOnRelay(true, sessionId, null, currentEpoch)
      }
      updateAllBadges()
    } else {
      // Currently LOCKED
      if (tabId === lockedTabId) {
        // Lock → X: unlock and disable globally
        await setLockOnRelay(false, sessionId, 'terminated', currentEpoch)
        extensionIsDisabled = true
        relayIsLocked = false
        lockedTabId = null
        
        // Detach all tabs
        for (const t of Array.from(tabs.keys())) {
          await detachTab(t, 'toggle').catch(() => {})
        }
        updateAllBadges()
      } else {
        // Steal Lock: current tab was not the locked one, make it the locked one
        if (!existing || existing.state !== 'connected') {
          const attached = await attachTab(tabId)
          await setLockOnRelay(true, attached.sessionId, null, currentEpoch)
        } else {
          await setLockOnRelay(true, sessionId, null, currentEpoch)
        }
        updateAllBadges()
      }
    }
  } finally {
    tabOperationLocks.delete(tabId)
  }
  })
}

function isDescendantOf(tabId, ancestorId) {
  const visited = new Set()
  let current = tabId
  while (current && !visited.has(current)) {
    visited.add(current)
    const parent = tabAncestry.get(current)
    if (parent === ancestorId) return true
    if (!parent) break
    current = parent
  }
  return false
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  let tabId = bySession?.tabId || (targetId ? getTabByTargetId(targetId) : null)

  if (extensionIsDisabled) {
    throw new Error('Extension is globally disabled. Commands from relay refused.')
  }

  // If tab is currently navigating or in sync transition, buffer the command
  if (tabId && (reattachingTabs.has(tabId) || pendingSwaps.has(tabId))) {
    console.log(`[OpenClaw] Buffering command ${method} for navigating tab ${tabId}`)
    if (!commandBuffers.has(tabId)) commandBuffers.set(tabId, [])
    const buffer = commandBuffers.get(tabId)
    if (buffer.length < 50) {
      return new Promise((resolve, reject) => {
        buffer.push({ ...msg, resolve, reject })
        // If it takes too long, reject
        setTimeout(() => {
          const currentBuffer = commandBuffers.get(tabId)
          if (currentBuffer) {
            const idx = currentBuffer.findIndex(c => c.id === msg.id)
            if (idx !== -1) {
              currentBuffer.splice(idx, 1)
              reject(new Error('Target is navigating (buffer timeout)'))
            }
          }
        }, 5000)
      })
    } else {
      throw new Error('Target is navigating (buffer full)')
    }
  }

  if (!tabId) {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [])
    if (active?.id && tabs.has(active.id) && tabs.get(active.id).state === 'connected') {
      tabId = active.id
    }
  }
  if (!tabId) {
    if (lockedTabId && tabs.has(lockedTabId) && tabs.get(lockedTabId).state === 'connected') {
      tabId = lockedTabId
    } else {
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') {
          tabId = id
          break
        }
      }
    }
  }

  if (relayIsLocked && lockedTabId && tabId !== lockedTabId) {
    // Check if this is a child session of the locked tab via ancestry
    const isChild = isDescendantOf(tabId, lockedTabId)
    // Also check direct child session mapping for iframes
    const isChildSession = Array.from(childSessionToTab.entries()).some(([sid, tid]) => tid === lockedTabId && sid === sessionId)
    
    if (!isChild && !isChildSession) {
      throw new Error('Extension relay is locked to another tab. Command refused.')
    }
  }

  if (!tabId) {
    throw new Error(`No attached tab for method ${method}`)
  }

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggerSession, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggerSession, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const url = typeof params?.url === 'string' ? params.url : 'about:blank'
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    
    // Register ancestry link immediately so the new tab inherits lock permissions
    if (tabId) tabAncestry.set(tab.id, tabId)
    
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      const allTabs = await chrome.tabs.query({})
      if (isLastRemainingTab(allTabs, toClose)) {
        console.warn('Refusing to close the last tab: this would kill the browser process')
        return { success: false, error: 'Cannot close the last tab' }
      }
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

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return

  whenReady(() => {
    if (extensionIsDisabled) return // Silence events if relay is conceptually off
    const tab = tabs.get(tabId)
    if (!tab?.sessionId) return

    if (method === 'Target.attachedToTarget' && params?.sessionId) {
      childSessionToTab.set(String(params.sessionId), tabId)
    }

    if (method === 'Target.detachedFromTarget' && params?.sessionId) {
      childSessionToTab.delete(String(params.sessionId))
    }

    if (relayIsLocked && lockedTabId) {
      // Forward only if it's the locked tab or a descendant (ancestry or iframe)
      const isDescendant = isDescendantOf(tabId, lockedTabId)
      const isChildSession = Array.from(childSessionToTab.entries()).some(([sid, tid]) => tid === lockedTabId && sid === source.sessionId)
      
      if (tabId !== lockedTabId && !isDescendant && !isChildSession) {
        return
      }
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
  })
}

async function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  
  await whenReady(async () => {
    activationEpoch++ // Identity transition firewall
    if (!tabs.has(tabId) && !reattachingTabs.has(tabId)) return

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

    if (reattachingTabs.has(tabId)) return

    const oldTab = tabs.get(tabId)
    if (!oldTab || !oldTab.sessionId) {
      void detachTab(tabId, reason)
      return
    }

    const oldSessionId = oldTab.sessionId
    const oldAttachOrder = oldTab.attachOrder
    const oldTargetId = oldTab.targetId

    // Begin re-attachment cycle
    reattachingTabs.set(tabId, { 
      sessionId: oldSessionId, 
      attachOrder: oldAttachOrder, 
      targetId: oldTargetId,
      attempts: 0 
    })
    tabs.delete(tabId)
    if (oldTargetId) targetToTab.delete(oldTargetId)
    
    // Clear child sessions, but keep tabBySession/tabAncestry mapping for continuity
    for (const [sid, tid] of childSessionToTab.entries()) {
      if (tid === tabId) childSessionToTab.delete(sid)
    }

    updateAllBadges()
    runReattachLoop(tabId)
  })
}

async function runReattachLoop(tabId) {
  // Staggered exponential backoff: 200ms, 500ms, 1s, 2s, 4s (~7.7s total)
  const delays = [200, 500, 1000, 2000, 4000]
  
  for (let attempt = 0; attempt < delays.length; attempt++) {
    await sleep(delays[attempt])
    
    const info = reattachingTabs.get(tabId)
    if (!info) return // Cancelled (e.g. tab closed or manual OFF)

    try {
      await chrome.tabs.get(tabId) // Confirm tab still exists
      await attachTab(tabId)
      console.log(`[OpenClaw] Re-attached tab ${tabId} successfully after navigation`)
      return
    } catch (err) {
      info.attempts++
      console.warn(`[OpenClaw] Re-attach attempt ${attempt + 1} for tab ${tabId} failed:`, err)
    }
  }

  // Final failure
  void detachTab(tabId, 'reattach_failed', 'Target navigation failed to recover attachment')
}

// Tab lifecycle listeners — clean up stale entries.
chrome.tabs.onRemoved.addListener((tabId) => void whenReady(() => {
  activationEpoch++
  void detachTab(tabId, 'tab_closed', 'Target tab was closed')
}))

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => void whenReady(async () => {
  console.log(`[OpenClaw] Tab ${removedTabId} replaced by ${addedTabId}. (Prerender-Swap)`)
  
  // 1. Transaction Start: Atomically lock the sync window and jump the epoch
  const currentEpoch = ++activationEpoch
  pendingSwaps.add(addedTabId)

  try {
    // 2. Child Session Zombie Cleanup: Notify relay of subframe death before purging mappings
    for (const [sid, tid] of childSessionToTab.entries()) {
      if (tid === removedTabId) {
        try {
          sendToRelay({
            method: 'forwardCDPEvent',
            params: {
              method: 'Target.detachedFromTarget',
              params: { sessionId: sid, reason: 'parent_replaced' },
            },
          })
        } catch {}
        childSessionToTab.delete(sid)
      }
    }

    // 3. Migrate Lock identity
    const meta = tabs.get(removedTabId)
    const reattachInfo = reattachingTabs.get(removedTabId)
    const sessionToLock = meta?.sessionId || reattachInfo?.sessionId

    if (lockedTabId === removedTabId) {
      lockedTabId = addedTabId
      if (sessionToLock) {
        void setLockOnRelay(true, sessionToLock, null, currentEpoch).catch(() => {})
      }
    }
    
    // 4. Migrate Routing Maps
    if (meta) {
      if (meta.sessionId) tabBySession.set(meta.sessionId, addedTabId)
      if (meta.targetId) targetToTab.set(meta.targetId, addedTabId)
      tabs.delete(removedTabId)
      tabs.set(addedTabId, meta)
    }

    // 5. Migrate Navigation State (reattachingTabs & commandBuffers)
    if (reattachInfo) {
      reattachingTabs.delete(removedTabId)
      reattachingTabs.set(addedTabId, reattachInfo)
      if (reattachInfo.targetId) targetToTab.set(reattachInfo.targetId, addedTabId)
      void runReattachLoop(addedTabId)
    }

    // 6. Migrate Command Buffers
    const bufferEntries = commandBuffers.get(removedTabId)
    if (bufferEntries) {
      commandBuffers.delete(removedTabId)
      commandBuffers.set(addedTabId, bufferEntries)
    }

    // 7. Migrate Ancestry Tree with Origin-Check Safety
    try {
      const tabInfo = await chrome.tabs.get(addedTabId)
      const isRestricted = tabInfo.url && (tabInfo.url.startsWith('chrome://') || tabInfo.url.startsWith('chrome-extension://'))
      
      for (const [cid, pid] of tabAncestry.entries()) {
        if (pid === removedTabId) {
          if (isRestricted) tabAncestry.delete(cid)
          else tabAncestry.set(cid, addedTabId)
        }
        if (cid === removedTabId) {
          tabAncestry.delete(cid)
          if (!isRestricted) tabAncestry.set(addedTabId, pid)
        }
      }
    } catch {
      // If we can't origin-check, be safe and drop ancestry for the removed identity
      tabAncestry.delete(removedTabId)
    }

    // 8. Identity Refresh: Sync and handle drift with Fallback attachment
    try {
      const info = /** @type {any} */ (await chrome.debugger.sendCommand({ tabId: addedTabId }, 'Target.getTargetInfo'))
      const freshTargetId = info?.targetInfo?.targetId
      if (freshTargetId && freshTargetId !== meta?.targetId) {
        console.log(`[OpenClaw] Identity Sync: Target ID shifted from ${meta?.targetId} to ${freshTargetId}`)
        if (meta) meta.targetId = freshTargetId
        targetToTab.set(freshTargetId, addedTabId)
        
        // Broadcast new identity to client immediately
        if (meta?.sessionId) {
          void sendToRelay({
            method: 'forwardCDPEvent',
            params: {
              method: 'Target.attachedToTarget',
              params: {
                sessionId: meta.sessionId,
                targetInfo: { ...info.targetInfo, attached: true },
                waitingForDebugger: false,
              },
            },
          })
        }
      }
    } catch (err) {
      console.warn('[OpenClaw] Identity Sync Failed - Triggering Emergency Re-attach:', err instanceof Error ? err.message : String(err))
      await detachTab(addedTabId, 'sync_failed', 'Identity synchronization failed') // Force a healthy reconnect
      return
    }

    // 9. Authoritative Status Sync (Epoch Synchronization)
    const activeMeta = tabs.get(addedTabId)
    const currentSessionId = activeMeta?.sessionId || null
    void setLockOnRelay(relayIsLocked, currentSessionId, relayIsLocked ? null : 'tracking', currentEpoch).catch(() => {})

    // 10. Final Buffer Flush: Close the sync window and release commands
    const buffer = commandBuffers.get(addedTabId) || []
    if (buffer.length > 0) {
      commandBuffers.delete(addedTabId)
      for (const cmd of buffer) {
        void handleForwardCdpCommand(cmd).then(
          res => sendToRelay({ id: cmd.id, result: res }, { silent: true }),
          err => sendToRelay({ id: cmd.id, error: err instanceof Error ? err.message : String(err) }, { silent: true })
        )
        await sleep(2)
      }
    }

  } finally {
    pendingSwaps.delete(addedTabId)
    updateAllBadges()
    void persistState()
  }
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
}))

chrome.tabs.onActivated.addListener(({ tabId }) => void whenReady(async () => {
  // No noise when disabled, and yield to concurrent prerender swaps
  if (extensionIsDisabled || pendingSwaps.has(tabId)) return 
  
  const currentEpoch = ++activationEpoch
  
  let tab = tabs.get(tabId)
  let reattachInfo = reattachingTabs.get(tabId)
  
  // Tracking Continuity: Auto-attach to the active tab if in "ON" (Tracking) mode
  // and the tab is currently idle/unattached.
  if (!relayIsLocked && !tab && !reattachInfo && !tabOperationLocks.has(tabId)) {
    try {
      const tabInfo = await chrome.tabs.get(tabId)
      // Only auto-attach to valid web pages (skip chrome://, etc.)
      if (tabInfo.url && !tabInfo.url.startsWith('chrome://') && !tabInfo.url.startsWith('chrome-extension://')) {
        tabOperationLocks.add(tabId)
        try {
          console.log(`[OpenClaw] Auto-attaching to active tab ${tabId} for tracking continuity`)
          await attachTab(tabId)
          tab = tabs.get(tabId) // Refresh local reference
        } catch (err) {
          // Log specific attachment failures to SW console
          console.warn(`[OpenClaw] Auto-attach failed for tab ${tabId} (${tabInfo.url}):`, err instanceof Error ? err.message : String(err))
          throw err
        } finally {
          tabOperationLocks.delete(tabId)
        }
      }
    } catch {
      // Tab might have been closed during the async gap
    }
  }

  if (!relayIsLocked) {
    const sessionId = (tab && tab.state === 'connected') ? (tab.sessionId || null) : (reattachInfo?.sessionId || null)
    // Send status update. If sessionId is still null (restricted page), the relay shows "No target"
    void setLockOnRelay(false, sessionId, 'tracking', currentEpoch).then(() => {
      if (activationEpoch === currentEpoch) updateAllBadges()
    }).catch(() => {})
  } else {
    // Locked mode logic
    if (tabId === lockedTabId) {
      updateAllBadges()
      return
    }
    const lockedTab = lockedTabId ? tabs.get(lockedTabId) : null
    const lockedReattach = lockedTabId ? reattachingTabs.get(lockedTabId) : null
    const lockedSessionId = lockedTab?.sessionId || lockedReattach?.sessionId || null
    void setLockOnRelay(true, lockedSessionId, 'lock_forbidden', currentEpoch).catch(() => {})
  }
  updateAllBadges()
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
      let activeTabId = null;
      try {
        const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
        
        // If the active tab is already one of our attached tabs, use it.
        if (active?.id && tabs.has(active.id)) {
          activeTabId = active.id;
        } else {
          // Otherwise, pick the most recently attached tab as a fallback
          const attachedIds = Array.from(tabs.keys()).sort((a, b) => {
            const ta = tabs.get(a)?.attachOrder || 0
            const tb = tabs.get(b)?.attachOrder || 0
            return tb - ta
          })
          activeTabId = attachedIds[0] || null
        }
      } catch {}

      // Resolve to session ID string (e.g. "cb-tab-1") for meaningful gateway logs
      const activeSessionId = activeTabId ? (tabs.get(activeTabId)?.sessionId || null) : null
      const result = await setLockOnRelay(!!locked, activeSessionId)
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
