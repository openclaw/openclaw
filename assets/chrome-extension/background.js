const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
  reattaching: { text: '↻', color: '#3B82F6' }, // NEW: reattaching state
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected'|'reattaching', sessionId?:string, targetId?:string, attachOrder?:number, autoReattach?:boolean}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// NEW: Track tabs that should auto-reattach after navigation
/** @type {Set<number>} */
const autoReattachTabs = new Set()

// NEW: Debounce reattachment attempts
/** @type {Map<number, NodeJS.Timeout>} */
const reattachTimeouts = new Map()

// IMPROVED: Persist auto-reattach tabs across extension restarts
async function saveAutoReattachTabs() {
  try {
    await chrome.storage.local.set({ autoReattachTabIds: Array.from(autoReattachTabs) })
  } catch (err) {
    console.warn('[OpenClaw] Failed to persist auto-reattach tabs:', err)
  }
}

async function loadAutoReattachTabs() {
  try {
    const stored = await chrome.storage.local.get(['autoReattachTabIds'])
    const ids = stored.autoReattachTabIds
    if (Array.isArray(ids)) {
      for (const id of ids) {
        if (typeof id === 'number') autoReattachTabs.add(id)
      }
      console.log(`[OpenClaw] Loaded ${autoReattachTabs.size} tabs for auto-reattach from storage`)
    }
  } catch (err) {
    console.warn('[OpenClaw] Failed to load auto-reattach tabs:', err)
  }
}

// IMPROVED: Restore attachments on extension startup
async function restoreAttachments() {
  if (autoReattachTabs.size === 0) return
  
  console.log(`[OpenClaw] Attempting to restore ${autoReattachTabs.size} tab attachments...`)
  
  // Verify tabs still exist and attempt to reattach
  const toRemove = []
  for (const tabId of autoReattachTabs) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (!tab || tab.status === 'loading') {
        console.log(`[OpenClaw] Tab ${tabId} not ready, will retry later`)
        continue
      }
      
      // Try to connect relay and attach
      try {
        await ensureRelayConnection()
        await attachTab(tabId, { skipAttachedEvent: false })
        console.log(`[OpenClaw] Successfully restored attachment for tab ${tabId}`)
      } catch (attachErr) {
        console.warn(`[OpenClaw] Failed to restore tab ${tabId}:`, attachErr)
        // Keep in set for manual retry
        setBadge(tabId, 'error')
        void chrome.action.setTitle({
          tabId,
          title: 'OpenClaw Browser Relay: connection failed (click to retry)',
        })
      }
    } catch (err) {
      // Tab no longer exists
      console.log(`[OpenClaw] Tab ${tabId} no longer exists, removing from auto-reattach`)
      toRemove.push(tabId)
    }
  }
  
  // Clean up non-existent tabs
  for (const id of toRemove) {
    autoReattachTabs.delete(id)
  }
  
  if (toRemove.length > 0) {
    await saveAutoReattachTabs()
  }
}

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

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    const ws = new WebSocket(wsUrl)
    relayWs = ws

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

    ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
    ws.onclose = () => onRelayClosed('closed')
    ws.onerror = () => onRelayClosed('error')

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

function onRelayClosed(reason) {
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  for (const tabId of tabs.keys()) {
    void chrome.debugger.detach({ tabId }).catch(() => {})
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: disconnected (click to re-attach)',
    })
  }
  tabs.clear()
  tabBySession.clear()
  childSessionToTab.clear()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
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
    pending.set(id, { resolve, reject })
    try {
      sendToRelay(command)
    } catch (err) {
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

  const sessionId = `cb-tab-${nextSession++}`
  const attachOrder = nextSession

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder, autoReattach: true })
  tabBySession.set(sessionId, tabId)
  autoReattachTabs.add(tabId) // NEW: Mark for auto-reattach
  void saveAutoReattachTabs() // IMPROVED: Persist to storage
  
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach) [auto-reattach ON]',
  })

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

  setBadge(tabId, 'on')
  console.log(`[OpenClaw] Tab ${tabId} attached with auto-reattach enabled`)
  return { sessionId, targetId }
}

async function detachTab(tabId, reason, opts = {}) {
  const tab = tabs.get(tabId)
  const shouldAutoReattach = autoReattachTabs.has(tabId) && !opts.permanent
  
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
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  // User dismissed the "debugging" infobar (Cancel / X) — treat as permanent detach.
  // DO NOT auto-reattach: it would re-show the infobar in a loop.
  if (reason === 'canceled_by_user') {
    console.log(`[OpenClaw] Tab ${tabId} detached by user (infobar dismissed). Stopping auto-reattach.`)
    autoReattachTabs.delete(tabId)
    void saveAutoReattachTabs()
    setBadge(tabId, 'off')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: detached by user (click to re-attach)',
    })
    return
  }

  // Navigation-triggered detach — schedule reattachment for any non-user reason
  if (shouldAutoReattach && reason !== 'canceled_by_user') {
    console.log(`[OpenClaw] Tab ${tabId} detached (${reason}), scheduling auto-reattach...`)
    setBadge(tabId, 'reattaching')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: reattaching after navigation...',
    })
    scheduleReattach(tabId)
    return
  }

  // Permanent detach (user clicked to toggle off)
  if (opts.permanent) {
    autoReattachTabs.delete(tabId)
    void saveAutoReattachTabs()
  }
  
  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })
}

// Schedule a reattachment attempt with debounce
function scheduleReattach(tabId) {
  // Clear any existing timeout
  const existing = reattachTimeouts.get(tabId)
  if (existing) clearTimeout(existing)
  
  // Wait 800ms for navigation to settle, then attempt reattach.
  // The onUpdated listener also triggers reattach on status=complete as backup.
  const timeout = setTimeout(() => {
    reattachTimeouts.delete(tabId)
    void attemptReattach(tabId)
  }, 800)
  
  reattachTimeouts.set(tabId, timeout)
}

// Attempt to reattach to a tab after navigation
async function attemptReattach(tabId, retries = 5) {
  if (!autoReattachTabs.has(tabId)) {
    console.log(`[OpenClaw] Tab ${tabId} no longer marked for auto-reattach`)
    return
  }
  
  // Already connected? Skip.
  if (tabs.has(tabId) && tabs.get(tabId).state === 'connected') {
    console.log(`[OpenClaw] Tab ${tabId} already connected, skipping reattach`)
    return
  }
  
  // Check if tab still exists
  try {
    const tab = await chrome.tabs.get(tabId)
    if (!tab) {
      autoReattachTabs.delete(tabId)
      void saveAutoReattachTabs()
      return
    }
    
    // Wait for page to be ready
    if (tab.status === 'loading') {
      console.log(`[OpenClaw] Tab ${tabId} still loading, waiting 500ms...`)
      setTimeout(() => void attemptReattach(tabId, retries), 500)
      return
    }
  } catch (err) {
    // Tab doesn't exist anymore
    autoReattachTabs.delete(tabId)
    void saveAutoReattachTabs()
    return
  }
  
  try {
    await ensureRelayConnection()
    await attachTab(tabId, { skipAttachedEvent: false })
    console.log(`[OpenClaw] ✅ Tab ${tabId} successfully reattached after navigation!`)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.warn(`[OpenClaw] Reattach attempt failed for tab ${tabId}: ${message}`)
    
    if (retries > 0) {
      // Exponential backoff: 600, 900, 1200, 1500, 1800ms
      const delay = 300 + (5 - retries) * 300
      console.log(`[OpenClaw] Retrying reattach for tab ${tabId} in ${delay}ms (${retries} retries left)...`)
      setTimeout(() => void attemptReattach(tabId, retries - 1), delay)
    } else {
      console.log(`[OpenClaw] Giving up on reattaching tab ${tabId}`)
      // Don't remove from autoReattachTabs — the onUpdated listener can still try
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: reattach failed (click to retry)',
      })
    }
  }
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    // User explicitly toggled off - permanent detach
    autoReattachTabs.delete(tabId)
    await detachTab(tabId, 'toggle', { permanent: true })
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
    })
    void maybeOpenHelpOnce()
    // Extra breadcrumbs in chrome://extensions service worker logs.
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  // Map command to tab
  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      // No sessionId: pick the first connected tab (stable-ish).
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') return id
      }
      return null
    })()

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

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
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
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId) && !autoReattachTabs.has(tabId)) return
  console.log(`[OpenClaw] Debugger detached from tab ${tabId}: reason="${reason}" (type=${typeof reason})`)
  void detachTab(tabId, reason || '')
}

// Listen for tab updates to handle SPA navigation and page reloads
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!autoReattachTabs.has(tabId)) return
  
  // When page finishes loading and we're not connected, reattach
  if (changeInfo.status === 'complete') {
    const existing = tabs.get(tabId)
    if (!existing || existing.state !== 'connected') {
      console.log(`[OpenClaw] Tab ${tabId} finished loading (onUpdated), attempting reattach...`)
      void attemptReattach(tabId)
    }
  }
})

// NEW: Clean up when tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  const wasTracked = autoReattachTabs.has(tabId)
  autoReattachTabs.delete(tabId)
  if (wasTracked) {
    void saveAutoReattachTabs() // IMPROVED: Persist removal
  }
  const timeout = reattachTimeouts.get(tabId)
  if (timeout) {
    clearTimeout(timeout)
    reattachTimeouts.delete(tabId)
  }
})

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

// IMPROVED: Load persisted tabs and restore attachments on startup
;(async () => {
  await loadAutoReattachTabs()
  // Delay restoration to let Chrome stabilize
  setTimeout(() => void restoreAttachments(), 1500)
})()

chrome.runtime.onInstalled.addListener(() => {
  // Useful: first-time instructions.
  void chrome.runtime.openOptionsPage()
})
