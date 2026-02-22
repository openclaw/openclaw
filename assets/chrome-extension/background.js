const DEFAULT_PORT = 18792

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void, timeoutId:number}>} */
const pending = new Map()

// ========== NEW: Operation locks to prevent double-attach races ==========
/** @type {Set<number>} */
const tabOperationLocks = new Set()

// ========== NEW: Reconnection state ==========
let reconnectTimer = null
let reconnectAttempts = 0
const MAX_RECONNECT_DELAY = 30000 // 30 seconds cap
const REQUEST_TIMEOUT = 30000 // 30 seconds for pending requests

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
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

function isUnsupportedTabUrl(url) {
  return (
    url.startsWith('chrome://') ||
    url.startsWith('chrome-extension://') ||
    url.startsWith('about:') ||
    url.startsWith('edge://') ||
    url.startsWith('devtools://')
  )
}

// ========== NEW: State persistence for MV3 service worker restarts ==========
async function saveState() {
  try {
    const state = {
      attachedTabs: Array.from(tabs.entries()),
      sessionMappings: Array.from(tabBySession.entries()),
      childSessions: Array.from(childSessionToTab.entries()),
      nextSession
    }
    await chrome.storage.local.set({ extensionState: state })
  } catch (err) {
    console.warn('Failed to save state:', err)
  }
}

async function restoreState() {
  try {
    const { extensionState } = await chrome.storage.local.get(['extensionState'])
    if (extensionState) {
      // Restore nextSession counter to avoid ID conflicts
      if (typeof extensionState.nextSession === 'number') {
        nextSession = extensionState.nextSession
      }
      
      // NOTE: We do NOT restore tab attachment state.
      // After a service worker restart or extension reload, debugger attachments
      // are lost. Restoring stale state causes the click handler to think tabs
      // are "connected" when they're not, leading to detach-instead-of-attach bugs.
      // Instead, we just restore the session counter and let the user re-attach
      // via the icon click (which triggers attachAllOpenTabs).
      console.log('State restored (nextSession counter only, tabs cleared)')
    }
    
    // Clear any stale persisted tab state
    await chrome.storage.local.remove(['extensionState'])
  } catch (err) {
    console.warn('Failed to restore state:', err)
  }
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  
  // ========== FIXED: Race condition in promise caching ==========
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const port = await getRelayPort()
    const gatewayToken = await getGatewayToken()
    const httpBase = `http://127.0.0.1:${port}`
    const wsUrl = gatewayToken
      ? `ws://127.0.0.1:${port}/extension?token=${encodeURIComponent(gatewayToken)}`
      : `ws://127.0.0.1:${port}/extension`

    // Fast preflight: is the relay server up?
    try {
      await fetch(`${httpBase}/`, { method: 'HEAD', signal: AbortSignal.timeout(2000) })
    } catch (err) {
      throw new Error(`Relay server not reachable at ${httpBase} (${String(err)})`)
    }

    if (!gatewayToken) {
      throw new Error(
        'Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)',
      )
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

    ws.onmessage = (event) => {
      onRelayMessage(String(event.data || '')).catch(err => {
        console.warn('Message handling failed:', err)
      })
    }
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

// ========== NEW: Auto-reconnection with exponential backoff ==========
function scheduleReconnect() {
  if (reconnectTimer) return
  
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), MAX_RECONNECT_DELAY)
  console.log(`Scheduling reconnect attempt ${reconnectAttempts + 1} in ${delay}ms`)
  
  // Update badge to show reconnecting state
  for (const tabId of tabs.keys()) {
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: `OpenClaw Browser Relay: reconnecting... (attempt ${reconnectAttempts + 1})`,
    })
  }
  
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null
    reconnectAttempts++
    
    try {
      await ensureRelayConnection()
      console.log('Reconnection successful')
      reconnectAttempts = 0
      
      // Re-attach previously tracked tabs
      await reattachKnownTabs()
    } catch (err) {
      console.warn(`Reconnect attempt ${reconnectAttempts} failed:`, err.message)
      if (reconnectAttempts < 10) { // Give up after 10 attempts
        scheduleReconnect()
      } else {
        console.error('Max reconnection attempts reached, giving up')
        // Set error badge for all tracked tabs
        for (const tabId of tabs.keys()) {
          setBadge(tabId, 'error')
          void chrome.action.setTitle({
            tabId,
            title: 'OpenClaw Browser Relay: connection failed (click to retry)',
          })
        }
      }
    }
  }, delay)
}

async function reattachKnownTabs() {
  // Save current tab IDs before cleanup — debuggers may still be attached
  // from before the WS drop (onRelayClosed no longer detaches them)
  const tabsToReattach = Array.from(tabs.keys())
  
  for (const tabId of tabsToReattach) {
    try {
      const tab = await chrome.tabs.get(tabId)
      if (tab) {
        // Detach first to avoid "Another debugger is already attached" errors
        try { await chrome.debugger.detach({ tabId }) } catch { /* may not be attached */ }
        
        // Clear stale state for this tab before re-attaching
        const oldState = tabs.get(tabId)
        if (oldState?.sessionId) tabBySession.delete(oldState.sessionId)
        tabs.delete(tabId)
        
        console.log(`Re-attaching tab ${tabId}`)
        await attachTab(tabId, { skipAttachedEvent: false })
      }
    } catch (err) {
      console.warn(`Failed to re-attach tab ${tabId}:`, err.message)
      tabs.delete(tabId)
    }
  }
  
  await saveState()
}

function onRelayClosed(reason) {
  relayWs = null
  
  // Clean up pending requests with timeout errors
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    clearTimeout(p.timeoutId)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  // ========== NEW: Save state before disconnecting ==========
  void saveState()

  // ========== CHANGED: Don't detach debuggers immediately, just update badge ==========
  for (const tabId of tabs.keys()) {
    setBadge(tabId, 'connecting')
    void chrome.action.setTitle({
      tabId,
      title: 'OpenClaw Browser Relay: disconnected (reconnecting...)',
    })
  }
  
  // ========== NEW: Auto-reconnect instead of giving up ==========
  scheduleReconnect()
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

// ========== FIXED: Pending request timeouts to prevent memory leaks ==========
function requestFromRelay(command) {
  const id = command.id
  return new Promise((resolve, reject) => {
    // Set up timeout to prevent memory leaks
    const timeoutId = setTimeout(() => {
      const p = pending.get(id)
      if (p) {
        pending.delete(id)
        reject(new Error('Request timeout after 30s'))
      }
    }, REQUEST_TIMEOUT)
    
    const wrappedResolve = (v) => {
      clearTimeout(timeoutId)
      resolve(v)
    }
    
    const wrappedReject = (e) => {
      clearTimeout(timeoutId)
      reject(e)
    }
    
    pending.set(id, { resolve: wrappedResolve, reject: wrappedReject, timeoutId })
    try {
      sendToRelay(command)
    } catch (err) {
      pending.delete(id)
      clearTimeout(timeoutId)
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
    clearTimeout(p.timeoutId)
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

  const sessionNumber = nextSession++
  const sessionId = `cb-tab-${sessionNumber}`
  const attachOrder = sessionNumber

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay: attached (click to detach)',
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
  
  // ========== NEW: Save state after successful attach ==========
  await saveState()
  
  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  
  // ========== NEW: Send detach events for child sessions ==========
  const childSessionsToDetach = []
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) {
      childSessionsToDetach.push(childSessionId)
    }
  }
  
  // Send detach events for child sessions first
  for (const childSessionId of childSessionsToDetach) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: childSessionId, reason: 'parent_detached' },
        },
      })
    } catch (err) {
      console.warn('Failed to send child detach event:', err)
    }
    childSessionToTab.delete(childSessionId)
  }
  
  // Send detach event for main session
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch (err) {
      console.warn('Failed to send detach event:', err)
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  try {
    await chrome.debugger.detach({ tabId })
  } catch (err) {
    console.warn('Failed to detach debugger:', err)
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })
  
  // ========== NEW: Save state after detach ==========
  await saveState()
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
    void saveState()
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
    void saveState()
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
  } catch (err) {
    console.warn('Failed to forward CDP event:', err)
  }
}

// ========== FIXED: Re-attach on navigation/reload ==========
function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  if (tabOperationLocks.has(tabId)) return

  tabOperationLocks.add(tabId)
  void (async () => {
    try {
      await detachTab(tabId, reason)
    } finally {
      tabOperationLocks.delete(tabId)
    }
  })()

  // If detached due to navigation/reload, try to re-attach after a delay
  if (reason === 'target_closed') {
    setTimeout(async () => {
      if (tabOperationLocks.has(tabId)) return

      tabOperationLocks.add(tabId)
      try {
        const tab = await chrome.tabs.get(tabId)
        const url = tab?.url || tab?.pendingUrl || ''
        if (!tab || isUnsupportedTabUrl(url) || relayWs?.readyState !== WebSocket.OPEN) return
        if (tabs.has(tabId)) return

        console.log(`Re-attaching tab ${tabId} after navigation`)
        await attachTab(tabId, { skipAttachedEvent: false })
      } catch (err) {
        console.warn(`Failed to re-attach tab ${tabId} after navigation:`, err.message)
      } finally {
        tabOperationLocks.delete(tabId)
      }
    }, 500)
  }
}

// ========== AUTO-ATTACH MODE ==========
let autoAttachEnabled = false

async function attachAllOpenTabs() {
  const allTabs = await chrome.tabs.query({})
  console.log(`attachAllOpenTabs: found ${allTabs.length} tabs`)
  let attached = 0, skipped = 0, failed = 0
  for (const tab of allTabs) {
    if (!tab.id) { skipped++; continue }
    if (tabs.has(tab.id)) { skipped++; continue }
    // Skip chrome:// and extension pages (can't attach debugger)
    const url = tab.url || tab.pendingUrl || ''
    if (isUnsupportedTabUrl(url)) {
      console.log(`Skipping tab ${tab.id}: ${url.substring(0, 60)}`)
      skipped++
      continue
    }
    if (tabOperationLocks.has(tab.id)) { skipped++; continue }
    
    tabOperationLocks.add(tab.id)
    try {
      // Verify tab still exists before attaching
      await chrome.tabs.get(tab.id)
      console.log(`Auto-attaching tab ${tab.id}: ${url.substring(0, 80)}`)
      await attachTab(tab.id)
      attached++
    } catch (err) {
      console.warn(`Failed to auto-attach tab ${tab.id} (${url.substring(0, 40)}):`, err.message)
      failed++
    } finally {
      tabOperationLocks.delete(tab.id)
    }
  }
  console.log(`attachAllOpenTabs complete: ${attached} attached, ${skipped} skipped, ${failed} failed`)
}

async function autoAttachNewTab(tabId, url) {
  if (!autoAttachEnabled) return
  if (tabs.has(tabId)) return
  if (url && isUnsupportedTabUrl(url)) return
  if (!relayWs || relayWs.readyState !== WebSocket.OPEN) return
  if (tabOperationLocks.has(tabId)) return
  
  tabOperationLocks.add(tabId)
  try {
    console.log(`Auto-attaching new tab ${tabId}`)
    await attachTab(tabId)
  } catch (err) {
    console.warn(`Failed to auto-attach new tab ${tabId}:`, err.message)
  } finally {
    tabOperationLocks.delete(tabId)
  }
}

// ========== Tab lifecycle listeners ==========
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabs.has(tabId)) {
    console.log(`Tab ${tabId} closed, cleaning up`)
    void detachTab(tabId, 'tab_closed')
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.url && tabs.has(tabId)) {
    console.log(`Tab ${tabId} navigated to ${changeInfo.url}`)
  }
  // Auto-attach when a tab finishes loading and we're in auto-attach mode
  if (changeInfo.status === 'complete' && autoAttachEnabled && !tabs.has(tabId)) {
    void autoAttachNewTab(tabId, changeInfo.url)
  }
})

// Auto-attach newly created tabs. URL is often empty here, so re-read tab state.
chrome.tabs.onCreated.addListener((tab) => {
  if (!tab.id || !autoAttachEnabled) return
  const tabId = tab.id
  setTimeout(async () => {
    try {
      const current = await chrome.tabs.get(tabId)
      const url = current?.url || current?.pendingUrl || ''
      if (isUnsupportedTabUrl(url)) return
      await autoAttachNewTab(tabId, url)
    } catch {
      // tab may no longer exist
    }
  }, 300)
})

// ========== NEW: MV3 keepalive via chrome.alarms ==========
chrome.alarms.create('relay-keepalive', { periodInMinutes: 0.4 }) // 24 seconds < 30s Chrome limit

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'relay-keepalive') {
    // Don't spin up relay unless the user has attached tabs or enabled auto-attach.
    if (tabs.size === 0 && !autoAttachEnabled) return

    // Check WebSocket health and reconnect if needed
    if (!relayWs || relayWs.readyState !== WebSocket.OPEN) {
      if (!relayConnectPromise && !reconnectTimer) {
        console.log('Keepalive: WebSocket unhealthy, triggering reconnect')
        await ensureRelayConnection().catch(() => {
          // If connection fails, scheduleReconnect will be called by onRelayClosed
        })
      }
    }
  }
})

// ========== NEW: Service worker startup - restore state ==========
chrome.runtime.onStartup.addListener(async () => {
  console.log('Service worker startup - restoring state')
  await restoreState()
})

// For development: also restore on extension reload
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // First-time installation: show options page
    void chrome.runtime.openOptionsPage()
  } else if (details.reason === 'update') {
    // Extension update: restore state
    console.log('Extension updated - restoring state')
    await restoreState()
    // Restore auto-attach mode
    const { autoAttachEnabled: stored } = await chrome.storage.local.get(['autoAttachEnabled'])
    if (stored) {
      autoAttachEnabled = true
      console.log('Restored auto-attach mode after update')
    }
  }
})

// Restore auto-attach on service worker wake
;(async () => {
  const { autoAttachEnabled: stored } = await chrome.storage.local.get(['autoAttachEnabled'])
  if (stored) {
    autoAttachEnabled = true
    console.log('Restored auto-attach mode on service worker init')
  }
})()

let clickActionInProgress = false

chrome.action.onClicked.addListener(async () => {
  if (clickActionInProgress) {
    console.log('Click ignored: action already in progress')
    return
  }
  clickActionInProgress = true

  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id

  try {
    // If clicking on an already-attached tab, detach just that tab
    if (tabId && tabs.get(tabId)?.state === 'connected') {
      if (tabOperationLocks.has(tabId)) return

      tabOperationLocks.add(tabId)
      try {
        await detachTab(tabId, 'toggle')
      } finally {
        tabOperationLocks.delete(tabId)
      }

      // If no more attached tabs, disable auto-attach
      if (tabs.size === 0) {
        autoAttachEnabled = false
        await chrome.storage.local.set({ autoAttachEnabled: false })
        console.log('All tabs detached, auto-attach disabled')
      }
      return
    }

    // Otherwise: enable auto-attach mode and attach ALL open tabs
    // Reset reconnection state on manual click
    reconnectAttempts = 0
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null }

    await ensureRelayConnection()
    autoAttachEnabled = true
    await chrome.storage.local.set({ autoAttachEnabled: true })
    console.log('Auto-attach mode enabled, attaching all tabs')
    await attachAllOpenTabs()
  } catch (err) {
    if (tabId) {
      setBadge(tabId, 'error')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: relay not running (open options for setup)',
      })
    }
    void maybeOpenHelpOnce()
    console.warn('attach failed:', err instanceof Error ? err.message : String(err))
  } finally {
    clickActionInProgress = false
  }
})
