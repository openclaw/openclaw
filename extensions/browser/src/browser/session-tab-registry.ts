/**
 * Session-owned browser tabs. Host-local durable ownership is canonical in
 * plugin SQLite; all other tabs remain process-local.
 */
import {
  captureBrowserSessionTabAuthority,
  isBrowserStateRuntimeCurrent,
  type BrowserSessionTabAuthority,
} from "../browser-runtime-state.js";
import {
  type CleanupKind,
  type CloseParams,
  closeDurableTab,
  isIgnorableTabCloseError,
} from "./session-tab-cleanup-claim.js";
import { resolveBrowserSessionKey } from "./session-tab-identity.js";
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
  withBrowserSessionTabOperation,
  type BrowserSessionTabRecord,
} from "./session-tab-store.js";
import {
  selectStaleTrackedTabs,
  selectTrackedTabsForSessions,
} from "./session-tab-sweep-selection.js";
import { readDurableTabs, resolveVolatile, type DurableTab } from "./session-tab-tracking.js";

export {
  filterTrackedSessionBrowserTabs,
  trackSessionBrowserTab,
  touchSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-tracking.js";

type TrackedTab = VolatileTab | DurableTab;

function readVolatileTabs(sessionKeys?: ReadonlySet<string>): Map<string, VolatileTab[]> {
  const current = volatileTabsBySession();
  const volatile = new Map<string, VolatileTab[]>();
  for (const sessionKey of sessionKeys ?? current.keys()) {
    if (resolveBrowserSessionKey(sessionKey) !== sessionKey) {
      continue;
    }
    const tabs = current.get(sessionKey);
    if (tabs) {
      volatile.set(sessionKey, Array.from(tabs.values()));
    }
  }
  return volatile;
}

async function performVolatileCleanup(
  candidate: VolatileTab,
  params: CloseParams,
  cleanupKind: CleanupKind,
): Promise<number> {
  const inFlight = volatileTabCleanupByTarget();
  const targetKey = volatileSessionTabTargetKey(candidate);
  let cancelledByActivity = false;
  const resolveCurrent = () => {
    const current = resolveVolatile(candidate)?.tab;
    if (current?.registration !== candidate.registration) {
      return undefined;
    }
    if (cleanupKind === "sweep" && !sameVolatileSessionTab(current, candidate)) {
      cancelledByActivity = true;
      return undefined;
    }
    return current;
  };
  for (let existing = inFlight.get(targetKey); existing; existing = inFlight.get(targetKey)) {
    const result = await existing;
    // Activity cancels a sweep, but not lifecycle cleanup of the same registration.
    if (cleanupKind !== "lifecycle" || !result.cancelledByActivity || !resolveCurrent()) {
      return 0;
    }
  }
  const attempt = Promise.resolve().then(async () => {
    if (params.prepareCurrent && !(await params.prepareCurrent())) {
      return 0;
    }
    if (!isCleanupCurrent(params)) {
      return 0;
    }
    params.authority?.assertCurrent?.();
    let tab = resolveCurrent();
    if (!tab) {
      return 0;
    }
    const registrations = volatileRegistrationsForTarget(targetKey);
    let closeTab = params.closeTab;
    try {
      if (!closeTab && tab.route.kind === "browser-control") {
        const { browserCloseTabByRawTargetId } = await import("./client-tab-close.runtime.js");
        const latest = resolveCurrent();
        if (!latest) {
          return 0;
        }
        tab = latest;
        closeTab = ({ baseUrl, targetId, profile }) =>
          browserCloseTabByRawTargetId(baseUrl, targetId, { profile });
      }
      params.authority?.assertCurrent?.();
      if (!isCleanupCurrent(params)) {
        return 0;
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
        deleteVolatileRegistrations(registrations);
        return outcome.status === "closed" ? 1 : 0;
      }
    } catch (error) {
      if (closeTab && tab.route.kind === "browser-control" && isIgnorableTabCloseError(error)) {
        deleteVolatileRegistrations(registrations);
        return 0;
      }
      params.onWarn?.(`failed to close tracked browser tab ${tab.targetId}: ${String(error)}`);
      return 0;
    }
    deleteVolatileRegistrations(registrations);
    return 1;
  });
  const cleanup = attempt
    .then((closed) => ({ closed, cancelledByActivity }))
    .finally(() => {
      inFlight.delete(targetKey);
    });
  inFlight.set(targetKey, cleanup);
  return (await cleanup).closed;
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

async function withTrackedTabCleanup<T>(
  authority: BrowserSessionTabAuthority,
  cleanup: () => Promise<T>,
): Promise<T> {
  // Whole cleanup lifetimes remain drainable without becoming dependencies of
  // their nested per-tab or dashboard admissions.
  return authority.runtime
    ? await withBrowserSessionTabOperation(Symbol("cleanup"), authority, cleanup)
    : await cleanup();
}

function isCleanupCurrent(params: CloseParams): boolean {
  return isBrowserStateRuntimeCurrent(params.authority?.runtime, params.isCurrent);
}

async function prepareTrackedTabCleanup(
  params: CloseParams & { sessionKeys?: Array<string | undefined> },
) {
  let dashboardClosed = 0;
  let durable = await readDurableTabs(params.onWarn, params.authority);
  const hasDashboard =
    durable.some((tab) => tab.dashboard) ||
    (await readBrowserDashboardStopIntents(params.authority)).length;
  if (hasDashboard) {
    const { reconcileBrowserDashboards } = await import("../browser-dashboard.js");
    if (!isCleanupCurrent(params)) {
      return { dashboardClosed, durable: undefined };
    }
    dashboardClosed = await reconcileBrowserDashboards(params);
    durable = await readDurableTabs(params.onWarn, params.authority);
  }
  return { dashboardClosed, durable: isCleanupCurrent(params) ? durable : undefined };
}

export async function closeTrackedBrowserTabsForSessions(
  input: CloseParams & { sessionKeys: Array<string | undefined>; now?: number },
): Promise<number> {
  if (input.sessionEntryCurrent && typeof input.prepareCurrent !== "function") {
    input.onWarn?.("browser cleanup unavailable: sessionEntryCurrent requires prepareCurrent");
    return 0;
  }
  const params = {
    ...input,
    authority: captureBrowserSessionTabAuthority(input.authority),
  };
  const sessionKeys = new Set(
    params.sessionKeys
      .map((key) => resolveBrowserSessionKey(key))
      .filter((key) => key !== undefined),
  );
  if (sessionKeys.size === 0) {
    return 0;
  }
  const volatile = readVolatileTabs(sessionKeys);
  return await withTrackedTabCleanup(params.authority, async () => {
    if (params.isCurrent?.() === false) {
      return 0;
    }
    // Without durable state, preserve immediate dispatch of the captured registration.
    const { dashboardClosed, durable } = params.authority.runtime
      ? await prepareTrackedTabCleanup({ ...params, sessionKeys: [...sessionKeys] })
      : { dashboardClosed: 0, durable: [] };
    if (!durable || !isCleanupCurrent(params)) {
      return dashboardClosed;
    }
    const tabs = selectTrackedTabsForSessions({
      durable,
      volatile,
      sessionKeys,
    });
    return (
      dashboardClosed +
      (await closeTrackedTabs(tabs, {
        ...params,
        cleanupKind: "lifecycle",
      }))
    );
  });
}

/** Closes and untracks stale, pending, or excess browser tabs. */
export async function sweepTrackedBrowserTabs(
  input: CloseParams & {
    now?: number;
    idleMs?: number;
    maxTabsPerSession?: number;
    ordinaryCleanup?: boolean;
    sessionFilter?: (sessionKey: string) => boolean;
  },
): Promise<number> {
  const params = {
    ...input,
    authority: captureBrowserSessionTabAuthority(input.authority),
  };
  const volatile =
    params.ordinaryCleanup === false ? [] : Array.from(readVolatileTabs().values()).flat();
  return await withTrackedTabCleanup(params.authority, async () => {
    const now = params.now ?? Date.now();
    const { dashboardClosed, durable } = params.authority.runtime
      ? await prepareTrackedTabCleanup(params)
      : { dashboardClosed: 0, durable: [] };
    if (!durable || !isCleanupCurrent(params)) {
      return dashboardClosed;
    }
    const lifecycleOnly = params.ordinaryCleanup === false;
    const tabs = lifecycleOnly
      ? durable.filter((tab) => !tab.dashboard && tab.cleanupKind === "lifecycle")
      : selectStaleTrackedTabs({
          tabs: [...durable, ...volatile],
          now,
          idleMs: params.idleMs,
          maxTabsPerSession: params.maxTabsPerSession,
          sessionFilter: params.sessionFilter,
        });
    return (
      dashboardClosed +
      (await closeTrackedTabs(tabs, {
        ...params,
        now,
        cleanupKind: lifecycleOnly ? "lifecycle" : "sweep",
      }))
    );
  });
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
