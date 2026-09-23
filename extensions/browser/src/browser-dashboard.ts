import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import {
  readBrowserDashboardDefinition,
  sameBrowserDashboardDefinition,
} from "./browser-dashboard-definition.js";
import type {
  BrowserDashboardDefinition,
  BrowserDashboardRequest,
  BrowserDashboardResponse,
} from "./browser-dashboard.types.js";
import {
  getBrowserStateRuntime,
  getOptionalBrowserStateRuntime,
  type BrowserDashboardOperation,
} from "./browser-runtime-state.js";
import { resolveCdpControlPolicy } from "./browser/cdp-reachability-policy.js";
import { closeTrackedCdpTarget, resolveCdpTabOwnership } from "./browser/cdp.helpers.js";
import { browserOpenTab, browserTabs } from "./browser/client.js";
import {
  isLocalManagedProfile,
  resolveBrowserConfig,
  resolveProfile,
  type ResolvedBrowserProfile,
} from "./browser/config.js";
import { withBrowserRequestScope } from "./browser/request-scope.js";
import {
  closeBrowserDashboardTabs,
  trackSessionBrowserTab,
} from "./browser/session-tab-registry.js";
import {
  deleteBrowserSessionTabIf,
  deleteBrowserDashboardStopIntent,
  parseBrowserSessionTabRecord,
  persistBrowserDashboardStopIntent,
  readBrowserDashboardStopIntent,
  readBrowserDashboardStopIntents,
  readBrowserDashboardTabs,
  sameBrowserSessionTabRecord,
  updateBrowserSessionTab,
  withoutBrowserSessionTabCleanup,
  type BrowserSessionTabRecord,
} from "./browser/session-tab-store.js";
import { getRuntimeConfig } from "./config/config.js";

type DashboardTab = BrowserSessionTabRecord & { storageKey: string };
const logger = createSubsystemLogger("browser");
export type BrowserDashboardAuthority = { signal?: AbortSignal; assertCurrent?: () => void };

function assertAuthority(authority: BrowserDashboardAuthority): void {
  authority.signal?.throwIfAborted();
  authority.assertCurrent?.();
}

function emitDashboardChanged(definition: BrowserDashboardDefinition): void {
  try {
    getOptionalBrowserStateRuntime()?.dashboardEvents?.emit(
      "dashboard_changed",
      {
        sessionKey: definition.sessionKey,
        name: definition.name,
        instanceId: definition.instanceId,
      },
      { scope: "operator.admin" },
    );
  } catch (error) {
    logger.warn(`Browser dashboard invalidation unavailable: ${String(error)}`);
  }
}

function operationKey(definition: BrowserDashboardDefinition): string {
  return JSON.stringify([definition.sessionKey, definition.agentId, definition.instanceId]);
}

function tabsForDefinition(
  definition: BrowserDashboardDefinition,
  storageKey?: string,
): DashboardTab[] {
  return readBrowserDashboardTabs(storageKey)
    .filter(
      (tab) =>
        tab.dashboard?.sessionKey === definition.sessionKey &&
        tab.dashboard?.instanceId === definition.instanceId &&
        tab.dashboard?.agentId === definition.agentId &&
        tab.dashboard?.name === definition.name,
    )
    .toSorted(
      (left, right) =>
        Number(right.dashboard?.state === "active") - Number(left.dashboard?.state === "active"),
    );
}

function definitionOwnsTab(
  definition: BrowserDashboardDefinition | undefined,
  tab: DashboardTab,
): boolean {
  return Boolean(
    definition &&
    definition.profile === tab.profile &&
    definition.url === tab.dashboard?.url &&
    definition.instanceId === tab.dashboard?.instanceId &&
    definition.sessionKey === tab.dashboard?.sessionKey,
  );
}

function responseFor(
  definition: BrowserDashboardDefinition,
  tab?: DashboardTab,
): BrowserDashboardResponse {
  const paused =
    tab?.dashboard?.state === "stopped" ||
    tab?.dashboard?.state === "stopping" ||
    (!tab &&
      sameBrowserDashboardDefinition(definition, readBrowserDashboardStopIntent(definition)));
  return {
    sessionKey: definition.sessionKey,
    name: definition.name,
    instanceId: definition.instanceId,
    revision: definition.revision,
    paused,
    stopping: tab?.dashboard?.state === "stopping",
    url: definition.url,
    ...(definition.title ? { title: definition.title } : {}),
    ...(tab?.dashboard?.state === "active"
      ? {
          browserTab: {
            target: "host" as const,
            profile: tab.profile,
            targetId: tab.nativeTargetId,
          },
        }
      : {}),
  };
}

async function requireDefinition(
  request: BrowserDashboardRequest,
  authority: BrowserDashboardAuthority,
): Promise<BrowserDashboardDefinition> {
  assertAuthority(authority);
  const definition = await readBrowserDashboardDefinition(request);
  assertAuthority(authority);
  if (!definition) {
    throw new Error(
      `Browser dashboard ${request.name} is missing, invalid, or was replaced. Read the dashboard; repair it with widget_put using an HTTP(S) URL and a local managed profile, or remove the widget.`,
    );
  }
  return definition;
}

async function assertDefinitionCurrent(
  definition: BrowserDashboardDefinition,
  authority: BrowserDashboardAuthority,
): Promise<void> {
  const current = await readBrowserDashboardDefinition(definition);
  assertAuthority(authority);
  if (!sameBrowserDashboardDefinition(definition, current)) {
    throw new Error(
      `Browser dashboard ${definition.name} changed during this operation. Retry with its current definition.`,
    );
  }
}

async function resolveManagedProfile(definition: BrowserDashboardDefinition) {
  const { getBrowserControlState } = await import("./browser-control-state.js");
  const state = getBrowserControlState();
  const config = state ? undefined : getRuntimeConfig();
  const resolved = state?.resolved ?? resolveBrowserConfig(config?.browser, config);
  const profile = resolveProfile(resolved, definition.profile);
  if (!profile || !isLocalManagedProfile(profile)) {
    throw new Error(
      `Browser dashboard ${definition.name} requires a local managed profile; ${definition.profile} cannot be attached or routed to another host.`,
    );
  }
  return { profile, resolved, ssrfPolicy: resolveCdpControlPolicy(profile, resolved.ssrfPolicy) };
}

function changeTabState(
  tab: DashboardTab,
  state: NonNullable<BrowserSessionTabRecord["dashboard"]>["state"],
): DashboardTab | undefined {
  let changed: DashboardTab | undefined;
  updateBrowserSessionTab(tab.storageKey, (raw) => {
    const current = parseBrowserSessionTabRecord(raw);
    if (!current?.dashboard || !sameBrowserSessionTabRecord(current, tab)) {
      return undefined;
    }
    const record = {
      ...withoutBrowserSessionTabCleanup(current),
      dashboard: { ...current.dashboard, state },
    };
    changed = { ...record, storageKey: tab.storageKey };
    return record;
  });
  return changed;
}

function deleteStoppedTab(tab: DashboardTab): boolean {
  return deleteBrowserSessionTabIf(tab.storageKey, (raw) => {
    const current = parseBrowserSessionTabRecord(raw);
    return Boolean(current && sameBrowserSessionTabRecord(current, tab));
  });
}

async function releaseTab(
  tab: DashboardTab,
  params: Parameters<typeof closeBrowserDashboardTabs>[1] = {},
): Promise<{ released: boolean; closed: number }> {
  if (tab.dashboard?.state === "stopped") {
    return { released: deleteStoppedTab(tab), closed: 0 };
  }
  const released = tab.dashboard?.state === "released" ? tab : changeTabState(tab, "released");
  const closed = released ? await closeBrowserDashboardTabs([released], params) : 0;
  return {
    released: !readBrowserDashboardTabs(tab.storageKey).some(
      (current) => current.storageKey === tab.storageKey,
    ),
    closed,
  };
}

async function observeExistingTab(
  definition: BrowserDashboardDefinition,
  tab: DashboardTab,
  authority: BrowserDashboardAuthority,
): Promise<"present" | "missing" | "different-browser" | "unreachable"> {
  const { profile, resolved, ssrfPolicy } = await resolveManagedProfile(definition);
  assertAuthority(authority);
  const tabs = await browserTabs(undefined, { profile: profile.name, signal: authority.signal });
  assertAuthority(authority);
  if (!tabs.running) {
    return "unreachable";
  }
  if (!tabs.tabs.some((candidate) => candidate.targetId === tab.nativeTargetId)) {
    return "missing";
  }
  const ownership = await resolveCdpTabOwnership({
    profileName: profile.name,
    cdpUrl: profile.cdpUrl,
    nativeTargetId: tab.nativeTargetId,
    ssrfPolicy,
    timeoutMs: resolved.remoteCdpTimeoutMs,
    signal: authority.signal,
  });
  assertAuthority(authority);
  if (ownership.status !== "durable") {
    throw new Error(
      `Could not verify the current browser instance for dashboard ${definition.name}. Retry when the browser is available; its existing tab has been kept.`,
    );
  }
  return ownership.profileFingerprint === tab.profileFingerprint &&
    ownership.browserInstanceFingerprint === tab.browserInstanceFingerprint
    ? "present"
    : "different-browser";
}

async function closeStoppingTab(
  tab: DashboardTab,
  definition: BrowserDashboardDefinition,
  params: Parameters<typeof closeBrowserDashboardTabs>[1] = {},
): Promise<number> {
  const closed = await closeBrowserDashboardTabs([tab], params);
  if (
    readBrowserDashboardTabs(tab.storageKey).some(
      (current) => current.storageKey === tab.storageKey && current.dashboard?.state === "stopped",
    )
  ) {
    emitDashboardChanged(definition);
  }
  return closed;
}

async function materialize(
  definition: BrowserDashboardDefinition,
  resume: boolean,
  authority: BrowserDashboardAuthority,
): Promise<BrowserDashboardResponse> {
  const { profile, resolved, ssrfPolicy } = await resolveManagedProfile(definition);
  assertAuthority(authority);
  const stoppedIntent = readBrowserDashboardStopIntent(definition);
  const superseded: { tab: DashboardTab; wasUnreachable: boolean }[] = [];
  for (const tab of tabsForDefinition(definition)) {
    if (!definitionOwnsTab(definition, tab) || tab.dashboard?.state === "released") {
      superseded.push({ tab, wasUnreachable: false });
      continue;
    }
    if (tab.dashboard?.state === "stopping" || tab.dashboard?.state === "stopped") {
      if (!resume) {
        await assertDefinitionCurrent(definition, authority);
        return responseFor(definition, tab);
      }
      superseded.push({ tab, wasUnreachable: false });
      continue;
    }
    const observation = await observeExistingTab(definition, tab, authority);
    if (observation === "present") {
      await assertDefinitionCurrent(definition, authority);
      const current = tabsForDefinition(definition, tab.storageKey).find(
        (candidate) => candidate.storageKey === tab.storageKey,
      );
      if (!current || current.dashboard?.state !== "active") {
        throw new Error("Dashboard tab stopped during this operation");
      }
      return responseFor(definition, current);
    }
    superseded.push({ tab, wasUnreachable: observation === "unreachable" });
  }
  await assertDefinitionCurrent(definition, authority);
  if (!resume && stoppedIntent && sameBrowserDashboardDefinition(stoppedIntent, definition)) {
    return responseFor(definition);
  }
  const opened = await browserOpenTab(undefined, definition.url, {
    profile: profile.name,
    signal: authority.signal,
    managedOnly: true,
  });
  const ownership = opened.ownership;
  try {
    await assertDefinitionCurrent(definition, authority);
    if (ownership?.status !== "durable" || opened.resolvedProfile !== profile.name) {
      throw new Error("Browser could not verify durable ownership for this dashboard tab");
    }
    if (
      superseded.some(
        ({ tab, wasUnreachable }) =>
          wasUnreachable &&
          tab.profileFingerprint === ownership.profileFingerprint &&
          tab.browserInstanceFingerprint === ownership.browserInstanceFingerprint,
      )
    ) {
      throw new Error(
        `Browser dashboard ${definition.name} was temporarily unreachable. Retry; its existing tab has been kept.`,
      );
    }
    // Opening first revives a stopped managed browser, making its old fingerprint
    // provably stale. A failed retirement compensates only this new target.
    for (const candidate of superseded) {
      if (
        candidate.tab.dashboard?.state === "stopping" &&
        definitionOwnsTab(definition, candidate.tab)
      ) {
        await closeStoppingTab(candidate.tab, definition);
        assertAuthority(authority);
        const stopped = tabsForDefinition(definition, candidate.tab.storageKey).find(
          (tab) =>
            tab.storageKey === candidate.tab.storageKey && tab.dashboard?.state === "stopped",
        );
        if (!stopped) {
          throw new Error(
            "Previous dashboard tab could not stop; retry when its browser is available",
          );
        }
        candidate.tab = stopped;
      }
      if (candidate.tab.dashboard?.state === "stopped") {
        continue;
      }
      if (!(await releaseTab(candidate.tab)).released) {
        throw new Error(
          "Previous dashboard tab could not be released; retry when its browser is available",
        );
      }
      assertAuthority(authority);
    }
    await assertDefinitionCurrent(definition, authority);
    trackSessionBrowserTab({
      sessionKey: definition.sessionKey,
      targetId: ownership.nativeTargetId,
      profile: profile.name,
      ownership,
      dashboard: {
        name: definition.name,
        sessionKey: definition.sessionKey,
        instanceId: definition.instanceId,
        agentId: definition.agentId,
        url: definition.url,
        state: "active",
      },
    });
    const tab = tabsForDefinition(definition).find(
      (candidate) =>
        candidate.nativeTargetId === ownership.nativeTargetId &&
        candidate.profileFingerprint === ownership.profileFingerprint &&
        candidate.browserInstanceFingerprint === ownership.browserInstanceFingerprint,
    );
    if (!tab) {
      throw new Error("Browser dashboard target registration failed");
    }
    // Keep paused intent across every await and failed write. The active row now
    // wins reads; conditional retirement misses are retried by reconciliation.
    for (const { tab: previous } of superseded) {
      if (previous.dashboard?.state === "stopped") {
        deleteStoppedTab(previous);
      }
    }
    if (stoppedIntent) {
      deleteBrowserDashboardStopIntent(stoppedIntent);
    }
    emitDashboardChanged(definition);
    return responseFor(definition, tab);
  } catch (error) {
    // Creation owns this exact tab even if the caller or board disappears while opening it.
    if (ownership?.status === "durable") {
      try {
        trackSessionBrowserTab({
          sessionKey: definition.sessionKey,
          targetId: ownership.nativeTargetId,
          profile: profile.name,
          ownership,
          dashboard: {
            sessionKey: definition.sessionKey,
            agentId: definition.agentId,
            name: definition.name,
            instanceId: definition.instanceId,
            url: definition.url,
            state: "released",
          },
        });
      } catch (trackingError) {
        // A full or unavailable store must still attempt cleanup on the captured endpoint.
        const outcome = await closeTrackedCdpTarget({
          profileName: profile.name,
          cdpUrl: profile.cdpUrl,
          nativeTargetId: ownership.nativeTargetId,
          expectedProfileFingerprint: ownership.profileFingerprint,
          expectedBrowserInstanceFingerprint: ownership.browserInstanceFingerprint,
          timeoutMs: resolved.remoteCdpTimeoutMs,
          ssrfPolicy,
        });
        if (outcome.status === "unavailable" || outcome.status === "cancelled") {
          throw new AggregateError(
            [error, trackingError],
            "Dashboard creation failed and its new tab could neither be retained nor closed",
            { cause: trackingError },
          );
        }
        throw error;
      }
      const released = tabsForDefinition(definition).find(
        (tab) =>
          tab.nativeTargetId === ownership.nativeTargetId &&
          tab.profileFingerprint === ownership.profileFingerprint &&
          tab.browserInstanceFingerprint === ownership.browserInstanceFingerprint,
      );
      if (!released || !(await releaseTab(released)).released) {
        throw new Error(
          "Dashboard creation failed; its retained cleanup record will retry closing the new tab",
          {
            cause: error,
          },
        );
      }
    }
    throw error;
  }
}

/** Re-resolve immediately before a model action crosses into Browser's normal dispatch. */
export async function assertBrowserDashboardTargetCurrent(
  response: BrowserDashboardResponse,
  agentId: string | undefined,
  authority: BrowserDashboardAuthority = {},
  profile?: ResolvedBrowserProfile,
): Promise<void> {
  const definition = await requireDefinition({ ...response, agentId }, authority);
  const target = response.browserTab;
  if (!target) {
    throw new Error("Dashboard has no active browser target");
  }
  const current = tabsForDefinition(definition).find(
    (tab) =>
      definitionOwnsTab(definition, tab) &&
      tab.dashboard?.state === "active" &&
      tab.nativeTargetId === target.targetId &&
      tab.profile === target.profile,
  );
  assertAuthority(authority);
  if (!current) {
    throw new Error("Dashboard browser target changed or stopped; resolve the dashboard again");
  }
  if (profile) {
    if (profile.name !== current.profile || !isLocalManagedProfile(profile)) {
      throw new Error("Dashboard browser profile changed; resolve the dashboard again");
    }
    const ownership = await resolveCdpTabOwnership({
      profileName: profile.name,
      cdpUrl: profile.cdpUrl,
      nativeTargetId: current.nativeTargetId,
      signal: authority.signal,
    });
    await assertDefinitionCurrent(definition, authority);
    const retained = tabsForDefinition(definition, current.storageKey).find(
      (tab) =>
        tab.storageKey === current.storageKey &&
        tab.dashboard?.state === "active" &&
        definitionOwnsTab(definition, tab),
    );
    assertAuthority(authority);
    if (
      !retained ||
      ownership.status !== "durable" ||
      ownership.profileFingerprint !== retained.profileFingerprint ||
      ownership.browserInstanceFingerprint !== retained.browserInstanceFingerprint
    ) {
      throw new Error(
        "Dashboard browser instance changed; reopen the dashboard before interacting",
      );
    }
  }
}

async function serializeDashboardOperation(
  request: BrowserDashboardRequest,
  kind: "materialize" | "stop",
  authority: BrowserDashboardAuthority,
  execute: (
    definition: BrowserDashboardDefinition,
    authority: BrowserDashboardAuthority,
  ) => Promise<BrowserDashboardResponse>,
): Promise<BrowserDashboardResponse> {
  const runtime = getBrowserStateRuntime();
  const boundAuthority = {
    ...authority,
    assertCurrent: () => {
      assertAuthority(authority);
      if (getBrowserStateRuntime() !== runtime) {
        throw new Error("Browser dashboard runtime changed");
      }
    },
  };
  const definition = await requireDefinition(request, boundAuthority);
  const operations = runtime.dashboardOperations;
  const key = operationKey(definition);
  const previous = operations.get(key);
  let materializationFailure: BrowserDashboardOperation["materializationFailure"];
  const promise = (async () => {
    await previous?.promise.catch(() => undefined);
    if (kind === "materialize") {
      materializationFailure = previous?.materializationFailure;
    }
    const current = await requireDefinition(definition, boundAuthority);
    if (
      materializationFailure &&
      !materializationFailure.callerCancelled &&
      sameBrowserDashboardDefinition(materializationFailure.definition, current)
    ) {
      throw materializationFailure.error;
    }
    materializationFailure = undefined;
    try {
      return await execute(current, boundAuthority);
    } catch (error) {
      if (kind === "materialize") {
        let callerCancelled = false;
        try {
          assertAuthority(boundAuthority);
        } catch {
          callerCancelled = true;
        }
        materializationFailure = { error, definition: current, callerCancelled };
      }
      throw error;
    }
  })();
  const pending = {
    promise,
    get materializationFailure() {
      return materializationFailure;
    },
  };
  // Publish each admitted successor before awaiting it, so Stop follows the full queue.
  operations.set(key, pending);
  try {
    return await promise;
  } finally {
    if (operations.get(key) === pending) {
      operations.delete(key);
    }
  }
}

/** Materialize once per board instance; hidden views do not own the target lifetime. */
export async function requestBrowserDashboard(
  request: BrowserDashboardRequest & { resume?: boolean },
  authority: BrowserDashboardAuthority = {},
): Promise<BrowserDashboardResponse> {
  return await serializeDashboardOperation(
    request,
    "materialize",
    authority,
    (definition, current) =>
      withBrowserRequestScope(
        { managedOnly: true, assertCurrent: () => assertDefinitionCurrent(definition, current) },
        async () => await materialize(definition, request.resume === true, current),
      ),
  );
}

/** Read saved Browser lifetime without opening or resuming a target. */
export async function inspectBrowserDashboard(
  request: BrowserDashboardRequest,
  authority: BrowserDashboardAuthority = {},
): Promise<BrowserDashboardResponse> {
  const definition = await requireDefinition(request, authority);
  const tab = tabsForDefinition(definition).find(
    (entry) => definitionOwnsTab(definition, entry) && entry.dashboard?.state !== "released",
  );
  return responseFor(definition, tab);
}

/** Explicit Stop follows all admitted opens and resumes before closing the owned target. */
export async function stopBrowserDashboard(
  request: BrowserDashboardRequest,
  authority: BrowserDashboardAuthority = {},
): Promise<BrowserDashboardResponse> {
  return await serializeDashboardOperation(request, "stop", authority, stopMaterializedDashboard);
}

async function stopMaterializedDashboard(
  definition: BrowserDashboardDefinition,
  authority: BrowserDashboardAuthority,
): Promise<BrowserDashboardResponse> {
  await assertDefinitionCurrent(definition, authority);
  for (const tab of tabsForDefinition(definition)) {
    if (!definitionOwnsTab(definition, tab)) {
      continue;
    }
    const stopping =
      tab.dashboard?.state === "stopped" ? undefined : changeTabState(tab, "stopping");
    if (!stopping && tab.dashboard?.state !== "stopped") {
      throw new Error("Dashboard target changed while stopping; retry Stop");
    }
    if (stopping) {
      emitDashboardChanged(definition);
      await closeStoppingTab(stopping, definition);
      assertAuthority(authority);
      if (
        readBrowserDashboardTabs(stopping.storageKey).some(
          (current) =>
            current.storageKey === stopping.storageKey && current.dashboard?.state === "stopping",
        )
      ) {
        throw new Error(
          "Dashboard is paused, but its browser tab could not close yet; cleanup will retry",
        );
      }
    }
  }
  await assertDefinitionCurrent(definition, authority);
  const current = tabsForDefinition(definition).find(
    (tab) => definitionOwnsTab(definition, tab) && tab.dashboard?.state !== "released",
  );
  if (!current) {
    persistBrowserDashboardStopIntent(definition);
    emitDashboardChanged(definition);
  }
  return responseFor(definition, current);
}

/** Existing cleanup cycle reconciles dashboard removal, replacement, and explicit stop. */
export async function reconcileBrowserDashboards(
  params: {
    sessionKeys?: Array<string | undefined>;
    isCurrent?: () => boolean;
    onWarn?: (message: string) => void;
  } = {},
): Promise<number> {
  if (!getOptionalBrowserStateRuntime()?.gateway) {
    return 0;
  }
  let closed = 0;
  for (const tab of readBrowserDashboardTabs()) {
    if (
      !tab.dashboard ||
      (params.sessionKeys && !params.sessionKeys.includes(tab.dashboard.sessionKey))
    ) {
      continue;
    }
    try {
      const definition = await readBrowserDashboardDefinition({
        ...tab.dashboard,
      });
      if (params.isCurrent?.() === false) {
        return closed;
      }
      if (!definitionOwnsTab(definition, tab) || tab.dashboard.state === "released") {
        closed += (await releaseTab(tab, params)).closed;
      } else if (definition && tab.dashboard.state === "stopping") {
        closed += await closeStoppingTab(tab, definition, params);
      } else if (
        definition &&
        tab.dashboard.state === "stopped" &&
        tabsForDefinition(definition).some(
          (candidate) =>
            candidate.dashboard?.state === "active" && definitionOwnsTab(definition, candidate),
        )
      ) {
        await releaseTab(tab, params);
      }
    } catch (error) {
      params.onWarn?.(
        `Could not reconcile Browser dashboard ${tab.dashboard.name}: ${String(error)}`,
      );
    }
  }
  for (const intent of readBrowserDashboardStopIntents()) {
    if (params.sessionKeys && !params.sessionKeys.includes(intent.sessionKey)) {
      continue;
    }
    try {
      const definition = await readBrowserDashboardDefinition(intent);
      if (params.isCurrent?.() === false) {
        return closed;
      }
      if (
        !sameBrowserDashboardDefinition(intent, definition) ||
        (definition &&
          tabsForDefinition(definition).some(
            (tab) => tab.dashboard?.state === "active" && definitionOwnsTab(definition, tab),
          ))
      ) {
        deleteBrowserDashboardStopIntent(intent);
      }
    } catch (error) {
      params.onWarn?.(`Could not reconcile Browser dashboard ${intent.name}: ${String(error)}`);
    }
  }
  return closed;
}
