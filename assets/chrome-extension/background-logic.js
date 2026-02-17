/**
 * Extracted, testable logic for the Chrome extension background service worker.
 *
 * All Chrome API dependencies are injected via the `deps` parameter so
 * this module can be tested with vitest alone (no browser required).
 */

/**
 * @typedef {Object} ReattachDeps
 * @property {Map<number, {state: string, sessionId?: string, targetId?: string, attachOrder?: number}>} tabs
 * @property {Map<number, () => void>} pendingReattach
 * @property {(tabId: number, kind: string) => void} setBadge
 * @property {(tabId: number, reason: string) => void|Promise<void>} detachTab
 * @property {() => Promise<void>} ensureRelayConnection
 * @property {(tabId: number, opts?: {skipAttachedEvent?: boolean}) => Promise<{sessionId: string, targetId: string}>} attachTab
 * @property {{ onUpdated: { addListener: Function, removeListener: Function }, onRemoved: { addListener: Function, removeListener: Function } }} tabEvents
 * @property {(fn: Function, ms: number) => ReturnType<typeof setTimeout>} setTimeout
 * @property {(id: ReturnType<typeof setTimeout>) => void} clearTimeout
 */

/** Detach reasons where auto-reattach should NOT be attempted. */
const PERMANENT_DETACH_REASONS = new Set([
  'canceled_by_user',
  'replaced_with_devtools',
])

/**
 * Handle a Chrome debugger detach event.
 *
 * For user-initiated detaches (cancel / DevTools takeover), permanently
 * detaches the tab. For transient detaches (navigation, crash), waits
 * for the page to finish loading and attempts to re-attach.
 *
 * @param {{ tabId?: number }} source
 * @param {string} reason
 * @param {ReattachDeps} deps
 */
export function handleDebuggerDetach(source, reason, deps) {
  const tabId = source.tabId
  if (!tabId) return
  if (!deps.tabs.has(tabId)) return

  if (PERMANENT_DETACH_REASONS.has(reason)) {
    void deps.detachTab(tabId, reason)
    return
  }

  // Cancel any previous pending reattach for this tab (rapid navigation guard)
  const prevCleanup = deps.pendingReattach.get(tabId)
  if (prevCleanup) prevCleanup()

  // Transient detach — wait for page load, then reattach
  deps.setBadge(tabId, 'connecting')

  const cleanup = () => {
    deps.tabEvents.onUpdated.removeListener(onUpdated)
    deps.tabEvents.onRemoved.removeListener(onRemoved)
    deps.clearTimeout(timeout)
    deps.pendingReattach.delete(tabId)
  }

  const onUpdated = async (updatedTabId, changeInfo) => {
    if (updatedTabId !== tabId || changeInfo.status !== 'complete') return
    cleanup()
    // Clean up the old session before reattaching: sends detachedFromTarget
    // to the relay and removes stale entries from tabBySession / tabs.
    // The Chrome debugger is already detached so the detach call inside is a no-op.
    try {
      await deps.detachTab(tabId, reason)
    } catch {
      return
    }
    // detachTab resets badge to 'off'; restore 'connecting' while we reattach.
    deps.setBadge(tabId, 'connecting')
    try {
      await deps.ensureRelayConnection()
      await deps.attachTab(tabId)
    } catch {
      void deps.detachTab(tabId, reason)
    }
  }

  const onRemoved = (removedTabId) => {
    if (removedTabId !== tabId) return
    cleanup()
    void deps.detachTab(tabId, 'tab_closed')
  }

  deps.tabEvents.onUpdated.addListener(onUpdated)
  deps.tabEvents.onRemoved.addListener(onRemoved)
  deps.pendingReattach.set(tabId, cleanup)

  // Give up after 10 seconds
  const timeout = deps.setTimeout(() => {
    cleanup()
    void deps.detachTab(tabId, reason)
  }, 10_000)
}

/**
 * Cancel all pending reattach attempts.
 * Called when the relay connection closes.
 *
 * @param {Map<number, () => void>} pendingReattach
 */
export function cancelAllPendingReattach(pendingReattach) {
  for (const cleanup of pendingReattach.values()) {
    cleanup()
  }
  pendingReattach.clear()
}
