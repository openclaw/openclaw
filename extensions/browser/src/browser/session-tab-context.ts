import { compensateBrowserTabTrackingFailure } from "../browser-tool-session-tabs.js";
import { resolveCdpControlPolicy } from "./cdp-reachability-policy.js";
import { readCdpSessionTabInventory } from "./cdp.helpers.js";
import type { BrowserOpenResult, BrowserTab } from "./client.types.js";
import { resolveBrowserEngine } from "./engines/registry.js";
import { BrowserTabNotFoundError, BrowserTargetAmbiguousError } from "./errors.js";
import { getBrowserProfileCapabilities } from "./profile-capabilities.js";
import { getBrowserRequestScope } from "./request-scope.js";
import { MANAGED_BROWSER_PAGE_TAB_LIMIT } from "./server-context.constants.js";
import type {
  BrowserOperationOptions,
  BrowserServerState,
  ProfileContext,
  ProfileRuntimeState,
} from "./server-context.types.js";
import { prepareScopedSessionTabRegistry } from "./session-tab-scoped.js";
import { resolveTargetIdFromTabs } from "./target-id.js";

/** Adapt the profile's operations, not individual routes, to the registry's session owner. */
export function createSessionTabContext(params: {
  profile: ProfileContext["profile"];
  runtime: ProfileRuntimeState;
  state: () => BrowserServerState;
  tabs: Pick<ProfileContext, "listTabs" | "openTab"> & {
    labelTab: (
      targetId: string,
      label: string,
      options?: BrowserOperationOptions,
    ) => Promise<BrowserTab>;
  };
  closeOpened: (tab: BrowserOpenResult, shouldClose: () => Promise<boolean>) => Promise<unknown>;
  closeOwned: (targetId: string) => Promise<unknown>;
}) {
  const scope = getBrowserRequestScope();
  if (!scope?.session) {
    return { tabs: params.tabs, runtime: params.runtime, scoped: false };
  }
  const session = scope.session;
  const profile = params.profile;
  // Selection is a request projection of canonical association/activity, never the profile-global sticky tab.
  const runtime: ProfileRuntimeState = { ...params.runtime, lastTargetId: null };
  const identity = (targetId: string) => ({ ...session, profile: profile.name, targetId });
  const owner = () => prepareScopedSessionTabRegistry(scope);
  const assertCurrent = () => scope.assertCurrent(profile);
  const listTabs = async (options?: BrowserOperationOptions): Promise<BrowserTab[]> => {
    await assertCurrent();
    const registry = await owner();
    const tabs = await params.tabs.listTabs(options);
    const candidate = tabs[0];
    const inventory =
      candidate && profile.driver !== "existing-session"
        ? await readCdpSessionTabInventory({
            profileName: profile.name,
            cdpUrl: profile.cdpUrl,
            nativeTargetId: candidate.targetId,
            signal: options?.signal,
            timeoutMs: options?.timeoutMs ?? params.state().resolved.remoteCdpTimeoutMs,
            ssrfPolicy: resolveCdpControlPolicy(profile, params.state().resolved.ssrfPolicy),
          })
        : undefined;
    const ownership = inventory?.ownership;
    await assertCurrent();
    let records = await registry.list(profile.name, ownership);
    let inherited = false;
    const ids = new Set(records.map((record) => record.targetId));
    // Identical URLs and labels are not evidence; only the native opener can extend ownership.
    for (let changed = true; changed;) {
      changed = false;
      for (const tab of tabs) {
        const openerId = inventory?.openers.get(tab.targetId) ?? tab.openerId;
        if (!ids.has(tab.targetId) && openerId && ids.has(openerId)) {
          inherited = true;
          const associated = await registry.inherit(
            {
              ...identity(tab.targetId),
              ownership:
                ownership?.status === "durable"
                  ? { ...ownership, nativeTargetId: tab.targetId }
                  : undefined,
              aliases: [tab.tabId, tab.label, tab.suggestedTargetId],
            },
            openerId,
          );
          if (associated) {
            ids.add(tab.targetId);
            changed = true;
          }
        }
      }
    }
    if (inherited) {
      records = await registry.list(profile.name, ownership);
    }
    const currentIds = new Set(records.map((record) => record.targetId));
    const filtered = tabs.filter((tab) => currentIds.has(tab.targetId));
    const latest = records.toSorted((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
    runtime.lastTargetId = latest?.targetId ?? null;
    return filtered;
  };
  const openTab: ProfileContext["openTab"] = async (url, options) => {
    await assertCurrent();
    const registry = await owner();
    const registration = registry.prepareRegistration();
    const opened = await params.tabs.openTab(url, {
      ...options,
      ...(profile.driver === "openclaw" &&
      profile.cdpIsLoopback &&
      !profile.attachOnly &&
      resolveBrowserEngine(profile.engine).descriptor.sessionScope !== "connection"
        ? { requireDurableOwnership: true }
        : {}),
    });
    const allocation = {
      ...identity(opened.targetId),
      ownership: opened.ownership,
      aliases: [opened.tabId, opened.label, opened.suggestedTargetId],
    };
    const compensate = () =>
      registration.cleanup(allocation, (shouldClose) => params.closeOpened(opened, shouldClose));
    scope.retainCreation?.(compensate);
    try {
      await assertCurrent();
      await registration.track(allocation);
      if (
        getBrowserProfileCapabilities(profile).supportsManagedTabLimit &&
        !params.state().resolved.attachOnly &&
        params.runtime.running
      ) {
        const pages = (await params.tabs.listTabs(options)).filter(
          (tab) => (tab.type ?? "page") === "page",
        );
        let excess = pages.length - MANAGED_BROWSER_PAGE_TAB_LIMIT;
        if (excess > 0) {
          const pageIds = new Set(pages.map((tab) => tab.targetId));
          const candidates = (await registry.list(profile.name, opened.ownership))
            .filter((tab) => tab.targetId !== opened.targetId && pageIds.has(tab.targetId))
            .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt);
          if (excess > candidates.length) {
            throw new Error(
              "Shared browser tab capacity is in use by other sessions. Close a tab before opening another.",
            );
          }
          for (const tab of candidates) {
            if (excess <= 0) {
              break;
            }
            await assertCurrent();
            await params.closeOwned(tab.targetId);
            await registry.untrack(identity(tab.targetId));
            excess--;
          }
        }
      }
      await assertCurrent();
    } catch (error) {
      await compensateBrowserTabTrackingFailure(error, compensate);
    }
    runtime.lastTargetId = opened.targetId;
    return opened;
  };
  const resolve = async (targetId: string, options?: BrowserOperationOptions) => {
    const result = resolveTargetIdFromTabs(targetId, await listTabs(options));
    if (!result.ok) {
      if (result.reason === "ambiguous") {
        throw new BrowserTargetAmbiguousError();
      }
      throw new BrowserTabNotFoundError({ input: targetId });
    }
    return result.targetId;
  };
  return {
    runtime,
    scoped: true,
    tabs: {
      listTabs,
      openTab,
      labelTab: async (targetId: string, label: string, options?: BrowserOperationOptions) => {
        const resolved = await resolve(targetId, options);
        await assertCurrent();
        return await params.tabs.labelTab(resolved, label, options);
      },
    },
    touch: async (targetId: string) => (await owner()).touch(identity(targetId)),
    untrack: async (targetId: string) => (await owner()).untrack(identity(targetId)),
  };
}
