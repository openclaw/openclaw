import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  readBrowserDashboardDefinition,
  sameBrowserDashboardDefinition,
} from "./browser-dashboard-definition.js";
import {
  changeTabState,
  closeStoppingTab,
  definitionOwnsTab,
  deleteStoppedTab,
  emitDashboardChanged,
  releaseTab,
  tabsForDefinition,
  type DashboardTab,
} from "./browser-dashboard-records.js";
import type {
  BrowserDashboardDefinition,
  BrowserDashboardRequest,
  BrowserDashboardResponse,
} from "./browser-dashboard.types.js";
import {
  getBrowserStateRuntime,
  getOptionalBrowserStateRuntime,
  isBrowserStateRuntimeCurrent,
  readCurrentBrowserState,
  type BrowserDashboardOperation,
  type BrowserSessionTabAuthority,
  type BrowserStateRuntime,
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
import { trackSessionBrowserTab } from "./browser/session-tab-registry.js";
import {
  deleteBrowserDashboardStopIntent,
  persistBrowserDashboardStopIntent,
  readBrowserDashboardStopIntent,
  readBrowserDashboardStopIntents,
  readBrowserDashboardTabs,
} from "./browser/session-tab-store.js";
import { withBrowserDashboardRegistration } from "./browser/session-tab-tracking.js";

export type BrowserDashboardAuthority = BrowserSessionTabAuthority & { signal?: AbortSignal };

function assertAuthority(authority: BrowserDashboardAuthority): void {
  authority.signal?.throwIfAborted();
  authority.assertCurrent?.();
}

function bindDashboardAuthority(authority: BrowserDashboardAuthority): BrowserDashboardAuthority & {
  runtime: BrowserStateRuntime;
} {
  const runtime = authority.runtime ?? getBrowserStateRuntime();
  return {
    ...authority,
    runtime,
    assertCurrent: () => {
      assertAuthority(authority);
      if (getOptionalBrowserStateRuntime() !== runtime) {
        throw new Error("Browser dashboard runtime changed");
      }
    },
  };
}

function operationKey(definition: BrowserDashboardDefinition): string {
  return JSON.stringify([definition.sessionKey, definition.agentId, definition.instanceId]);
}

function responseFor(
  definition: BrowserDashboardDefinition,
  tab?: DashboardTab,
  stopped = false,
): BrowserDashboardResponse {
  const paused =
    tab?.dashboard?.state === "stopped" ||
    tab?.dashboard?.state === "stopping" ||
    (!tab && stopped);
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

async function materialize(
  definition: BrowserDashboardDefinition,
  resume: boolean,
  authority: BrowserDashboardAuthority,
): Promise<BrowserDashboardResponse> {
  const { profile, resolved, ssrfPolicy } = await resolveManagedProfile(definition);
  assertAuthority(authority);
  const stoppedIntent = await readBrowserDashboardStopIntent(definition, authority);
  assertAuthority(authority);
  const superseded: { tab: DashboardTab; wasUnreachable: boolean }[] = [];
  const tabs = await tabsForDefinition(definition, authority);
  assertAuthority(authority);
  for (const tab of tabs) {
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
      const current = (await tabsForDefinition(definition, authority, tab.storageKey))[0];
      assertAuthority(authority);
      if (!current || current.dashboard?.state !== "active") {
        throw new Error("Dashboard tab stopped during this operation");
      }
      return responseFor(definition, current);
    }
    superseded.push({ tab, wasUnreachable: observation === "unreachable" });
  }
  await assertDefinitionCurrent(definition, authority);
  if (!resume && stoppedIntent && sameBrowserDashboardDefinition(stoppedIntent, definition)) {
    return responseFor(definition, undefined, true);
  }
  const opened = await browserOpenTab(undefined, definition.url, {
    profile: profile.name,
    signal: authority.signal,
    managedOnly: true,
  });
  const ownership = opened.ownership;
  let materialized: DashboardTab;
  try {
    if (ownership?.status !== "durable" || opened.resolvedProfile !== profile.name) {
      throw new Error("Browser could not verify durable ownership for this dashboard tab");
    }
    materialized = await withBrowserDashboardRegistration(
      ownership.nativeTargetId,
      profile.name,
      authority,
      async (registrationAuthority) => {
        await assertDefinitionCurrent(definition, registrationAuthority);
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
            await closeStoppingTab(candidate.tab, definition, registrationAuthority);
            assertAuthority(registrationAuthority);
            const stopped = (
              await tabsForDefinition(definition, registrationAuthority, candidate.tab.storageKey)
            ).find((tab) => tab.dashboard?.state === "stopped");
            assertAuthority(registrationAuthority);
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
          if (!(await releaseTab(candidate.tab, registrationAuthority)).released) {
            throw new Error(
              "Previous dashboard tab could not be released; retry when its browser is available",
            );
          }
          assertAuthority(registrationAuthority);
        }
        await assertDefinitionCurrent(definition, registrationAuthority);
        const tab = await trackSessionBrowserTab({
          sessionKey: definition.sessionKey,
          targetId: ownership.nativeTargetId,
          profile: profile.name,
          ownership,
          authority: registrationAuthority,
          dashboard: {
            name: definition.name,
            sessionKey: definition.sessionKey,
            instanceId: definition.instanceId,
            agentId: definition.agentId,
            url: definition.url,
            state: "active",
          },
        });
        if (!tab) {
          throw new Error("Browser dashboard target registration failed");
        }
        return tab;
      },
    );
  } catch (error) {
    // Creation owns this exact tab even if the caller or board disappears while opening it.
    if (ownership?.status === "durable") {
      const cleanupAuthority = { runtime: authority.runtime };
      try {
        await trackSessionBrowserTab({
          sessionKey: definition.sessionKey,
          targetId: ownership.nativeTargetId,
          profile: profile.name,
          ownership,
          authority: cleanupAuthority,
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
      const released = (await tabsForDefinition(definition, cleanupAuthority)).find(
        (tab) =>
          tab.nativeTargetId === ownership.nativeTargetId &&
          tab.profileFingerprint === ownership.profileFingerprint &&
          tab.browserInstanceFingerprint === ownership.browserInstanceFingerprint,
      );
      if (!released || !(await releaseTab(released, cleanupAuthority)).released) {
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
  // Accepted registration transfers cleanup to the durable owner. Later caller
  // cancellation or definition changes must not compensate a committed target.
  assertAuthority(authority);
  emitDashboardChanged(definition, authority);
  for (const { tab: previous } of superseded) {
    if (previous.dashboard?.state === "stopped") {
      await deleteStoppedTab(previous, authority);
    }
  }
  if (stoppedIntent) {
    await deleteBrowserDashboardStopIntent(stoppedIntent, authority);
  }
  assertAuthority(authority);
  return responseFor(definition, materialized);
}

/** Re-resolve immediately before a model action crosses into Browser's normal dispatch. */
export async function assertBrowserDashboardTargetCurrent(
  response: BrowserDashboardResponse,
  agentId: string | undefined,
  suppliedAuthority: BrowserDashboardAuthority = {},
  profile?: ResolvedBrowserProfile,
): Promise<void> {
  const authority = bindDashboardAuthority(suppliedAuthority);
  const definition = await requireDefinition({ ...response, agentId }, authority);
  const target = response.browserTab;
  if (!target) {
    throw new Error("Dashboard has no active browser target");
  }
  const current = (await tabsForDefinition(definition, authority)).find(
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
    const retained = (await tabsForDefinition(definition, authority, current.storageKey)).find(
      (tab) => tab.dashboard?.state === "active" && definitionOwnsTab(definition, tab),
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
  const boundAuthority = bindDashboardAuthority(authority);
  const runtime = boundAuthority.runtime;
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
  suppliedAuthority: BrowserDashboardAuthority = {},
): Promise<BrowserDashboardResponse> {
  const authority = bindDashboardAuthority(suppliedAuthority);
  const definition = await requireDefinition(request, authority);
  const stoppedIntent = await readBrowserDashboardStopIntent(definition, authority);
  const tab = (await tabsForDefinition(definition, authority)).find(
    (entry) => definitionOwnsTab(definition, entry) && entry.dashboard?.state !== "released",
  );
  assertAuthority(authority);
  return responseFor(definition, tab, sameBrowserDashboardDefinition(definition, stoppedIntent));
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
  const tabs = await tabsForDefinition(definition, authority);
  assertAuthority(authority);
  for (const tab of tabs) {
    if (!definitionOwnsTab(definition, tab)) {
      continue;
    }
    const stopping =
      tab.dashboard?.state === "stopped"
        ? undefined
        : await changeTabState(tab, "stopping", authority);
    assertAuthority(authority);
    if (!stopping && tab.dashboard?.state !== "stopped") {
      throw new Error("Dashboard target changed while stopping; retry Stop");
    }
    if (stopping) {
      emitDashboardChanged(definition, authority);
      await closeStoppingTab(stopping, definition, authority);
      assertAuthority(authority);
      if (
        (await readBrowserDashboardTabs(stopping.storageKey, authority)).some(
          (current) => current.dashboard?.state === "stopping",
        )
      ) {
        throw new Error(
          "Dashboard is paused, but its browser tab could not close yet; cleanup will retry",
        );
      }
    }
  }
  await assertDefinitionCurrent(definition, authority);
  const current = (await tabsForDefinition(definition, authority)).find(
    (tab) => definitionOwnsTab(definition, tab) && tab.dashboard?.state !== "released",
  );
  assertAuthority(authority);
  if (!current) {
    await persistBrowserDashboardStopIntent(definition, authority);
    assertAuthority(authority);
    emitDashboardChanged(definition, authority);
  }
  return responseFor(definition, current, !current);
}

/** Existing cleanup cycle reconciles dashboard removal, replacement, and explicit stop. */
export async function reconcileBrowserDashboards(
  params: {
    sessionKeys?: Array<string | undefined>;
    isCurrent?: () => boolean;
    onWarn?: (message: string) => void;
  } = {},
): Promise<number> {
  const runtime = getOptionalBrowserStateRuntime();
  if (!runtime?.gateway) {
    return 0;
  }
  const isCurrent = () => isBrowserStateRuntimeCurrent(runtime, params.isCurrent);
  const authority: BrowserSessionTabAuthority = {
    runtime,
    assertCurrent: () => {
      if (!isCurrent()) {
        throw new Error("Browser dashboard cleanup is no longer current");
      }
    },
  };
  let closed = 0;
  if (!isCurrent()) {
    return closed;
  }
  const tabs = await readCurrentBrowserState(
    runtime,
    () => readBrowserDashboardTabs(undefined, { runtime }),
    params.isCurrent,
  );
  if (!tabs || !isCurrent()) {
    return closed;
  }
  for (const tab of tabs) {
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
      if (!isCurrent()) {
        return closed;
      }
      if (!definitionOwnsTab(definition, tab) || tab.dashboard.state === "released") {
        closed += (await releaseTab(tab, authority, params)).closed;
      } else if (definition && tab.dashboard.state === "stopping") {
        closed += await closeStoppingTab(tab, definition, authority, params);
      } else if (
        definition &&
        tab.dashboard.state === "stopped" &&
        (await tabsForDefinition(definition, authority)).some(
          (candidate) =>
            candidate.dashboard?.state === "active" && definitionOwnsTab(definition, candidate),
        )
      ) {
        await releaseTab(tab, authority, params);
      }
    } catch (error) {
      if (!isCurrent()) {
        return closed;
      }
      params.onWarn?.(
        `Could not reconcile Browser dashboard ${tab.dashboard.name}: ${String(error)}`,
      );
    }
  }
  if (!isCurrent()) {
    return closed;
  }
  const intents = await readCurrentBrowserState(
    runtime,
    () => readBrowserDashboardStopIntents({ runtime }),
    params.isCurrent,
  );
  if (!intents || !isCurrent()) {
    return closed;
  }
  for (const intent of intents) {
    if (params.sessionKeys && !params.sessionKeys.includes(intent.sessionKey)) {
      continue;
    }
    try {
      const definition = await readBrowserDashboardDefinition(intent);
      if (!isCurrent()) {
        return closed;
      }
      if (
        !sameBrowserDashboardDefinition(intent, definition) ||
        (definition &&
          (await tabsForDefinition(definition, authority)).some(
            (tab) => tab.dashboard?.state === "active" && definitionOwnsTab(definition, tab),
          ))
      ) {
        await deleteBrowserDashboardStopIntent(intent, authority);
      }
    } catch (error) {
      if (!isCurrent()) {
        return closed;
      }
      params.onWarn?.(`Could not reconcile Browser dashboard ${intent.name}: ${String(error)}`);
    }
  }
  return closed;
}
