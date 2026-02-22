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

/** @type {Map<number, {state:'connecting'|'connected'|'pending_reattach', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

/** @type {Map<number, {resolve:(v:any)=>void, reject:(e:Error)=>void}>} */
const pending = new Map()

// ===== FIX #1 & #2: Auto-reconnect state =====
let reconnectAttempt = 0
let reconnectTimer = null

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

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
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
      let connected = false
      ws.onopen = () => {
        clearTimeout(t)
        connected = true
        // Install permanent handlers immediately on connect (before resolve)
        // to close the race window where WS could drop between resolve and handler install
        ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
        ws.onclose = () => onRelayClosed('closed')
        ws.onerror = () => onRelayClosed('error')
        resolve()
      }
      ws.onerror = () => {
        clearTimeout(t)
        if (!connected) reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        if (!connected) reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }

    // ===== FIX #2: Reset reconnect counter on successful connection =====
    reconnectAttempt = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

// ===== FIX #1: DON'T detach debugger sessions on WS drop =====
function onRelayClosed(reason) {
  relayWs = null
  for (const [id, p] of pending.entries()) {
    pending.delete(id)
    p.reject(new Error(`Relay disconnected (${reason})`))
  }

  // Keep debugger attached — only update badge to show disconnected state.
  // When we reconnect, we'll re-announce existing sessions.
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: reconnecting…',
      })
    }
  }
  // DON'T: tabs.clear(), tabBySession.clear(), childSessionToTab.clear()
  // DON'T: chrome.debugger.detach()

  // ===== FIX #2: Schedule auto-reconnect =====
  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) return // already scheduled
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000) + Math.random() * 500
  reconnectAttempt++
  console.log(`[OpenClaw Relay] Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    try {
      await ensureRelayConnection()
      console.log('[OpenClaw Relay] Reconnected successfully')

      // Re-announce all still-attached tabs
      for (const [tabId, tab] of tabs.entries()) {
        if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
          try {
            const chromeTab = await chrome.tabs.get(tabId).catch(() => null)
            if (!chromeTab) {
              cleanupTab(tabId)
              continue
            }

            // Verify debugger still attached
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
              expression: '1',
              returnByValue: true,
            })

            // Re-announce to the relay server
            const info = /** @type {any} */ (
              await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
            )
            const targetInfo = info?.targetInfo
            tab.targetId = String(targetInfo?.targetId || '').trim() || tab.targetId

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
            setBadge(tabId, 'on')
            void chrome.action.setTitle({
              tabId,
              title: 'OpenClaw Browser Relay: attached (click to detach)',
            })
            console.log(`[OpenClaw Relay] Re-announced tab ${tabId} (session: ${tab.sessionId})`)
          } catch (err) {
            console.warn(`[OpenClaw Relay] Failed to re-announce tab ${tabId}:`, err)
            cleanupTab(tabId)
          }
        }
      }
    } catch (err) {
      console.log(`[OpenClaw Relay] Reconnect failed: ${err instanceof Error ? err.message : err}`)
      reconnectTimer = null
      scheduleReconnect()
      return
    }
    reconnectTimer = null
  }, delay)
}

// ===== FIX #3: Persist state to chrome.storage.session for MV3 worker restarts =====
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({ relayTabs: tabEntries, nextSession })
  } catch {
    // chrome.storage.session may not be available in all contexts
  }
}

async function restoreState() {
  try {
    const stored = await chrome.storage.session.get(['relayTabs', 'nextSession'])
    if (!stored.relayTabs?.length) return false
    if (stored.nextSession) nextSession = stored.nextSession

    let restored = 0
    for (const entry of stored.relayTabs) {
      const { tabId, sessionId, targetId, attachOrder } = entry

      const chromeTab = await chrome.tabs.get(tabId).catch(() => null)
      if (!chromeTab) continue

      try {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: '1',
          returnByValue: true,
        })
      } catch {
        console.log(`[OpenClaw Relay] Tab ${tabId} debugger lost — attempting re-attach`)
        try {
          await chrome.debugger.attach({ tabId }, '1.3')
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable')
          console.log(`[OpenClaw Relay] Tab ${tabId} re-attached successfully`)
        } catch (reattachErr) {
          console.warn(`[OpenClaw Relay] Tab ${tabId} re-attach failed:`, reattachErr)
          setBadge(tabId, 'off')
          continue
        }
      }

      tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
      tabBySession.set(sessionId, tabId)
      setBadge(tabId, 'on')
      restored++
    }

    if (restored > 0) {
      console.log(`[OpenClaw Relay] Restored ${restored} tab(s) from session storage`)

      if (!debuggerListenersInstalled) {
        debuggerListenersInstalled = true
        chrome.debugger.onEvent.addListener(onDebuggerEvent)
        chrome.debugger.onDetach.addListener(onDebuggerDetach)
      }

      try {
        await ensureRelayConnection()
        for (const [tabId, tab] of tabs.entries()) {
          if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
            try {
              const info = /** @type {any} */ (
                await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
              )
              sendToRelay({
                method: 'forwardCDPEvent',
                params: {
                  method: 'Target.attachedToTarget',
                  params: {
                    sessionId: tab.sessionId,
                    targetInfo: { ...(info?.targetInfo || {}), attached: true },
                    waitingForDebugger: false,
                  },
                },
              })
            } catch (err) {
              console.warn(`[OpenClaw Relay] restoreState: failed to re-announce tab ${tabId}:`, err)
              cleanupTab(tabId)
            }
          }
        }
      } catch {
        scheduleReconnect()
      }
      return true
    }
  } catch (err) {
    console.warn('[OpenClaw Relay] Failed to restore state:', err)
  }
  return false
}

function cleanupTab(tabId) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  setBadge(tabId, 'off')
  void persistState()
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

  // ===== FIX #3: Persist state after attach =====
  void persistState()

  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
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

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'OpenClaw Browser Relay (click to attach/detach)',
  })

  // ===== FIX #3: Persist state after detach =====
  void persistState()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle')
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
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
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
  if (!tabs.has(tabId)) return

  // Navigation causes 'target_closed' — don't nuke state, try to re-attach
  if (reason === 'target_closed') {
    const tab = tabs.get(tabId)
    if (tab?.state === 'connected') {
      console.log(`[OpenClaw Relay] Tab ${tabId} detached (navigation) — will re-attach`)
      tab.state = 'pending_reattach'
      setBadge(tabId, 'connecting')
      // Wait for navigation to settle, then re-attach
      setTimeout(() => void reattachAfterNavigation(tabId), 500)
      return
    }
  }

  void detachTab(tabId, reason)
}

async function reattachAfterNavigation(tabId) {
  const tab = tabs.get(tabId)
  if (!tab || tab.state !== 'pending_reattach') return

  const chromeTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!chromeTab) {
    console.log(`[OpenClaw Relay] Tab ${tabId} gone after navigation — cleaning up`)
    cleanupTab(tabId)
    return
  }

  // Retry re-attach up to 3 times (page might still be loading)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable')

      // Get new target info and re-announce
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      const targetInfo = info?.targetInfo
      tab.state = 'connected'
      tab.targetId = String(targetInfo?.targetId || '').trim() || tab.targetId

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
      } catch {
        // WS might be down — scheduleReconnect will handle it
      }

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'OpenClaw Browser Relay: attached (click to detach)',
      })
      void persistState()
      console.log(`[OpenClaw Relay] Tab ${tabId} re-attached after navigation (attempt ${attempt + 1})`)
      return
    } catch (err) {
      console.log(`[OpenClaw Relay] Tab ${tabId} re-attach attempt ${attempt + 1} failed: ${err}`)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000))
    }
  }

  console.warn(`[OpenClaw Relay] Tab ${tabId} re-attach failed after 3 attempts — giving up`)
  cleanupTab(tabId)
}

// ===== FIX #4: Tab lifecycle cleanup =====
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabs.has(tabId)) return
  console.log(`[OpenClaw Relay] Tab ${tabId} closed — cleaning up`)
  void detachTab(tabId, 'tab_closed')
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!tabs.has(removedTabId)) return
  console.log(`[OpenClaw Relay] Tab ${removedTabId} replaced by ${addedTabId} — cleaning up`)
  void detachTab(removedTabId, 'tab_replaced')
})

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

// ===== FIX #5: Keepalive via chrome.alarms =====
chrome.alarms.create('relay-keepalive', { periodInMinutes: 4 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  if (tabs.size === 0) return
  console.log(`[OpenClaw Relay] Keepalive ping — ${tabs.size} tab(s) attached`)

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected') continue
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '"keepalive"',
        returnByValue: true,
      })
    } catch {
      console.warn(`[OpenClaw Relay] Keepalive: tab ${tabId} debugger lost — cleaning up`)
      cleanupTab(tabId)
    }
  }
})

// ===== FIX #3: Restore state on service worker startup =====
void restoreState().then((restored) => {
  if (restored) {
    console.log('[OpenClaw Relay] Service worker restarted — state restored from session storage')
  }
})
