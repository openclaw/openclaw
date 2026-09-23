import { AsyncLocalStorage } from "node:async_hooks";
import type { OpenClawPluginGatewayEvents } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeAgentId, parseAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { getBrowserStateRuntime, getOptionalBrowserStateRuntime } from "./browser-runtime-state.js";
import { readBrowserDashboardSessionOwners } from "./browser/session-tab-store.js";

/** One service subscription owns discovery and reconciliation through shutdown. */
export function bindBrowserDashboardEvents(
  events: OpenClawPluginGatewayEvents,
  onWarn: (message: string) => void,
): () => Promise<void> {
  const runtime = getBrowserStateRuntime();
  const pendingSessions = new Set<string>();
  const pendingAgentSessions = new Set<string>();
  let reconciliation: Promise<void> | undefined;
  let accepting = true;
  const isCurrentRuntime = () => getOptionalBrowserStateRuntime() === runtime;
  const clearPending = () => {
    pendingSessions.clear();
    pendingAgentSessions.clear();
  };
  const reconcilePending = () => {
    if (reconciliation || pendingSessions.size === 0 || !isCurrentRuntime()) {
      return;
    }
    reconciliation = (async () => {
      while (pendingSessions.size > 0 && isCurrentRuntime()) {
        const sessions = new Set(pendingSessions);
        const agentSessions = new Set(pendingAgentSessions);
        clearPending();
        const dashboards = await readBrowserDashboardSessionOwners();
        if (!isCurrentRuntime()) {
          return;
        }
        const sessionKeys = new Set<string>();
        for (const dashboard of dashboards) {
          if (
            sessions.has(dashboard.sessionKey) ||
            (dashboard.agentId &&
              agentSessions.has(
                JSON.stringify([
                  dashboard.agentId,
                  parseAgentSessionKey(dashboard.sessionKey)?.rest,
                ]),
              ))
          ) {
            sessionKeys.add(dashboard.sessionKey);
          }
        }
        if (sessionKeys.size === 0) {
          continue;
        }
        const { reconcileBrowserDashboards } = await import("./browser-dashboard.js");
        if (!isCurrentRuntime()) {
          return;
        }
        await reconcileBrowserDashboards({ sessionKeys: [...sessionKeys], onWarn });
      }
    })()
      .catch((error: unknown) => {
        clearPending();
        onWarn(`Browser dashboard reconciliation failed: ${String(error)}`);
      })
      .finally(() => {
        reconciliation = undefined;
        if (accepting && isCurrentRuntime()) {
          reconcilePending();
        } else {
          clearPending();
        }
      });
  };
  runtime.dashboardEvents = events;
  const onBoardChanged: Parameters<typeof events.onSessionsChanged>[0] = (event) => {
    if (!accepting || !isCurrentRuntime() || event.reason !== "board") {
      return;
    }
    pendingSessions.add(event.sessionKey);
    if (event.agentId) {
      pendingAgentSessions.add(JSON.stringify([normalizeAgentId(event.agentId), event.sessionKey]));
    }
    reconcilePending();
  };
  // Board publishers run outside the service's instance-local runtime scope.
  let unsubscribe: (() => void) | undefined = events.onSessionsChanged(
    AsyncLocalStorage.bind(onBoardChanged),
  );
  return async () => {
    accepting = false;
    unsubscribe?.();
    unsubscribe = undefined;
    if (runtime.dashboardEvents === events) {
      runtime.dashboardEvents = undefined;
    }
    await reconciliation;
    clearPending();
  };
}
