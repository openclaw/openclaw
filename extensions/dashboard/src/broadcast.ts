// Single-slot handle for the gateway's broadcast function.
//
// Agent tools must be able to announce `plugin.dashboard.changed` so an open
// Control UI live-updates. They cannot always reach one: the plugin runtime's
// gateway-request scope is an AsyncLocalStorage set around gateway RPC handlers
// and plugin HTTP routes only, so a tool call inside an agent turn that started
// from a channel, cron, or heartbeat sees no scope and would silently skip the
// broadcast — the edit lands on disk but no browser hears about it.
//
// `GatewayBroadcastFn` is server-lifetime (it fans out to every connection), not
// request- or connection-scoped, so remembering the first one a gateway method
// receives is sound. The Control UI calls `dashboard.workspace.get` on load, so
// the slot is populated long before an agent edits anything.

export type DashboardBroadcast = (event: string, payload: unknown) => void;

let handle: DashboardBroadcast | undefined;

/** Called by every dashboard gateway method; idempotent after the first call. */
export function rememberDashboardBroadcast(broadcast: DashboardBroadcast): void {
  handle = broadcast;
}

/** The remembered broadcast, or undefined before any gateway method has run. */
export function dashboardBroadcast(): DashboardBroadcast | undefined {
  return handle;
}

/** Test-only: clear the remembered handle between cases. */
export function resetDashboardBroadcastForTest(): void {
  handle = undefined;
}
