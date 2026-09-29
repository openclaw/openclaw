import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";
/**
 * Session-owned browser tabs. Host-local durable ownership is canonical in
 * plugin SQLite; all other tabs remain process-local.
 */
import {
  getOptionalBrowserStateRuntime,
  isBrowserStateRuntimeCurrent,
  readCurrentBrowserState,
} from "../browser-runtime-state.js";
import type { BrowserSessionTabAuthority } from "./session-tab-authority.js";
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
  const resolveCurrent = () => {
    const current = resolveVolatile(candidate)?.tab;
    return current?.registration === candidate.registration &&
      (cleanupKind !== "sweep" || sameVolatileSessionTab(current, candidate))
      ? current
      : undefined;
  };
  while (true) {
    if (params.prepareCurrent && !(await params.prepareCurrent())) {
      return 0;
    }
    if (!isCleanupCurrent(params)) {
      return 0;
    }
    params.authority?.assertCurrent?.();
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

    const { promise: cleanup, resolve: complete } = createDeferred<number>();
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
  let durable = await readCurrentBrowserState(
    params.authority?.runtime,
    () => readDurableTabs(params.onWarn, params.authority),
    params.isCurrent,
  );
  if (!durable) {
    return { dashboardClosed, durable };
  }
  const hasDashboard =
    durable.some((tab) => tab.dashboard) ||
    (
      await readCurrentBrowserState(
        params.authority?.runtime,
        () => readBrowserDashboardStopIntents(params.authority),
        params.isCurrent,
      )
    )?.length;
  if (hasDashboard) {
    const { reconcileBrowserDashboards } = await import("../browser-dashboard.js");
    if (!isCleanupCurrent(params)) {
      return { dashboardClosed, durable: undefined };
    }
    dashboardClosed = await reconcileBrowserDashboards(params);
    durable = await readCurrentBrowserState(
      params.authority?.runtime,
      () => readDurableTabs(params.onWarn, params.authority),
      params.isCurrent,
    );
  }
  return { dashboardClosed, durable: isCleanupCurrent(params) ? durable : undefined };
}

/** Closes and untracks tabs for the supplied session keys. */
export async function closeTrackedBrowserTabsForSessions(
  input: CloseParams & { sessionKeys: Array<string | undefined>; now?: number },
): Promise<number> {
  if (input.sessionEntryCurrent && typeof input.prepareCurrent !== "function") {
    input.onWarn?.("browser cleanup unavailable: sessionEntryCurrent requires prepareCurrent");
    return 0;
  }
  const params = {
    ...input,
    authority: {
      ...input.authority,
      runtime: input.authority?.runtime ?? getOptionalBrowserStateRuntime() ?? undefined,
    },
  };
  const sessionKeys = new Set(
    params.sessionKeys
      .map((key) => normalizeOptionalLowercaseString(key))
      .filter((key) => key !== undefined),
  );
  const volatile = readVolatileTabs(sessionKeys);
  return await withTrackedTabCleanup(params.authority, async () => {
    if (params.isCurrent?.() === false) {
      return 0;
    }
    // Without durable state, preserve immediate dispatch of the captured registration.
    const { dashboardClosed, durable } = params.authority.runtime
      ? await prepareTrackedTabCleanup(params)
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
    authority: {
      ...input.authority,
      runtime: input.authority?.runtime ?? getOptionalBrowserStateRuntime() ?? undefined,
    },
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
    if (params.ordinaryCleanup === false) {
      return (
        dashboardClosed +
        (await closeTrackedTabs(
          durable.filter((tab) => !tab.dashboard && tab.cleanupKind === "lifecycle"),
          { ...params, now, cleanupKind: "lifecycle" },
        ))
      );
    }
    return (
      dashboardClosed +
      (await closeTrackedTabs(
        selectStaleTrackedTabs({
          tabs: [...durable, ...volatile],
          now,
          idleMs: params.idleMs,
          maxTabsPerSession: params.maxTabsPerSession,
          sessionFilter: params.sessionFilter,
        }),
        { ...params, now, cleanupKind: "sweep" },
      ))
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
