/**
 * Session-owned browser tabs. Host-local durable ownership is canonical in
 * plugin SQLite; all other tabs remain process-local.
 */
import {
  type CleanupKind,
  type CloseParams,
  closeDurableTab,
  isIgnorableTabCloseError,
} from "./session-tab-cleanup-claim.js";
import {
  deleteVolatileRegistrations,
  sameVolatileSessionTab,
  type VolatileSessionTab as VolatileTab,
  volatileRegistrationsForTarget,
  volatileSessionTabTargetKey,
  volatileTabCleanupByTarget,
  volatileTabsBySession,
} from "./session-tab-process-state.js";
import {
  readBrowserDashboardStopIntents,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";
import {
  selectStaleTrackedTabs,
  selectTrackedTabsForSessions,
} from "./session-tab-sweep-selection.js";
import { readDurableTabs, resolveVolatile, type DurableTab } from "./session-tab-tracking.js";

export {
  trackSessionBrowserTab,
  touchSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-tracking.js";

type TrackedTab = VolatileTab | DurableTab;

async function performVolatileCleanup(
  candidate: VolatileTab,
  params: CloseParams,
  cleanupKind: CleanupKind,
): Promise<number> {
  const inFlight = volatileTabCleanupByTarget();
  const targetKey = volatileSessionTabTargetKey(candidate);
  const resolveCurrent = () => {
    const current = resolveVolatile(candidate)?.tab;
    return current?.registration === candidate.registration &&
      (cleanupKind !== "sweep" || sameVolatileSessionTab(current, candidate))
      ? current
      : undefined;
  };
  while (true) {
    const current = resolveCurrent();
    if (!current) {
      return 0;
    }
    const existing = inFlight.get(targetKey);
    if (existing) {
      await existing.promise;
      if (existing.registrations.some((owned) => owned.registration === candidate.registration)) {
        return 0;
      }
      continue;
    }

    let complete!: (operation: Promise<number>) => void;
    const cleanup = new Promise<number>((resolve) => {
      complete = resolve;
    });
    // Preparation and dispatch share one reservation, including reentrant closers.
    // Completion retires only the acquired registrations.
    const owner = { registrations: volatileRegistrationsForTarget(targetKey), promise: cleanup };
    const performClose = async () => {
      let tab = current;
      let closeTab = params.closeTab;
      try {
        if (!closeTab && tab.route.kind === "browser-control") {
          const { browserCloseTabByRawTargetId } = await import("./client.js");
          const latest = resolveCurrent();
          if (!latest) {
            // No dispatch occurred: a lifecycle joiner may retry a touched sweep.
            owner.registrations = [];
            return 0;
          }
          tab = latest;
          closeTab = ({ baseUrl, targetId, profile }) =>
            browserCloseTabByRawTargetId(baseUrl, targetId, { profile });
        }
        if (closeTab) {
          await closeTab({
            targetId: tab.targetId,
            ...(tab.route.kind === "browser-control" && tab.route.baseUrl
              ? { baseUrl: tab.route.baseUrl }
              : {}),
            ...(tab.route.kind === "node-proxy" ? { route: tab.route } : {}),
            ...(tab.profile ? { profile: tab.profile } : {}),
          });
        } else if (tab.route.kind === "node-proxy") {
          const outcome = await tab.route.closeTarget({
            targetId: tab.targetId,
            profile: tab.profile,
            ownership: tab.ownership,
          });
          if (outcome.status === "cancelled" || outcome.status === "unavailable") {
            params.onWarn?.(
              `deferred tracked browser tab ${tab.targetId}: ${outcome.status === "unavailable" ? outcome.reason : "cleanup cancelled"}`,
            );
            return 0;
          }
          if (outcome.status === "ownership-mismatch") {
            params.onWarn?.(`retired tracked browser tab ${tab.targetId}: ownership mismatch`);
          }
          deleteVolatileRegistrations(owner.registrations);
          return outcome.status === "closed" ? 1 : 0;
        }
      } catch (error) {
        if (closeTab && tab.route.kind === "browser-control" && isIgnorableTabCloseError(error)) {
          deleteVolatileRegistrations(owner.registrations);
          return 0;
        }
        params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(error)}`);
        return 0;
      }
      deleteVolatileRegistrations(owner.registrations);
      return 1;
    };
    inFlight.set(targetKey, owner);
    try {
      complete(performClose());
      return await cleanup;
    } finally {
      // Queued handoff callers must see the reservation until its completion settles.
      if (inFlight.get(targetKey) === owner) {
        inFlight.delete(targetKey);
      }
    }
  }
}

async function closeTrackedTabs(
  tabs: TrackedTab[],
  params: CloseParams & { cleanupKind: CleanupKind; now?: number },
): Promise<number> {
  let closed = 0;
  const now = params.now ?? Date.now();
  for (const tab of tabs) {
    closed +=
      tab.kind === "durable"
        ? await closeDurableTab(tab, params, now, params.cleanupKind)
        : await performVolatileCleanup(tab, params, params.cleanupKind);
  }
  return closed;
}

/** Closes and untracks tabs for the supplied session keys. */
export async function closeTrackedBrowserTabsForSessions(
  params: CloseParams & { sessionKeys: Array<string | undefined>; now?: number },
): Promise<number> {
  let dashboardClosed = 0;
  if (
    readDurableTabs(params.onWarn).some((tab) => tab.dashboard) ||
    readBrowserDashboardStopIntents().length > 0
  ) {
    const { reconcileBrowserDashboards } = await import("../browser-dashboard.js");
    dashboardClosed = await reconcileBrowserDashboards(params);
  }
  const tabs = selectTrackedTabsForSessions({
    durable: readDurableTabs(params.onWarn),
    sessionKeys: params.sessionKeys,
  });
  return (
    dashboardClosed +
    (await closeTrackedTabs(tabs, {
      ...params,
      cleanupKind: "lifecycle",
    }))
  );
}

/** Closes and untracks stale, pending, or excess browser tabs. */
export async function sweepTrackedBrowserTabs(
  params: CloseParams & {
    now?: number;
    idleMs?: number;
    maxTabsPerSession?: number;
    ordinaryCleanup?: boolean;
    sessionFilter?: (sessionKey: string) => boolean;
  },
): Promise<number> {
  const now = params.now ?? Date.now();
  let dashboardClosed = 0;
  if (
    readDurableTabs(params.onWarn).some((tab) => tab.dashboard) ||
    readBrowserDashboardStopIntents().length > 0
  ) {
    const { reconcileBrowserDashboards } = await import("../browser-dashboard.js");
    dashboardClosed = await reconcileBrowserDashboards(params);
  }
  if (params.ordinaryCleanup === false) {
    return dashboardClosed;
  }
  const volatile: VolatileTab[] = [];
  for (const tabs of volatileTabsBySession().values()) {
    volatile.push(...tabs.values());
  }
  return (
    dashboardClosed +
    (await closeTrackedTabs(
      selectStaleTrackedTabs({
        tabs: [...readDurableTabs(params.onWarn), ...volatile],
        now,
        idleMs: params.idleMs,
        maxTabsPerSession: params.maxTabsPerSession,
        sessionFilter: params.sessionFilter,
      }),
      { ...params, now, cleanupKind: "sweep" },
    ))
  );
}

/** Browser dashboard lifetime changes reuse fingerprinted cleanup and its claim owner. */
export async function closeBrowserDashboardTabs(
  tabs: Array<BrowserSessionTabRecord & { storageKey: string }>,
  params: CloseParams = {},
): Promise<number> {
  return await closeTrackedTabs(
    tabs.map((tab) => ({ ...tab, kind: "durable" as const })),
    {
      ...params,
      getResolvedBrowserConfig:
        params.getResolvedBrowserConfig ??
        (async () => {
          const { getBrowserControlState } = await import("../browser-control-state.js");
          return getBrowserControlState()?.resolved ?? null;
        }),
      cleanupKind: "lifecycle",
    },
  );
}
