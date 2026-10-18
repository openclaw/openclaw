import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  PluginStateKeyedStore,
  SessionEntryCurrentPreparation,
} from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserToolSessionTabs } from "../browser-tool-session-tabs.js";
import { readDurableTabAlias, readVolatileTabAlias } from "./session-tab-ephemeral-aliases.js";
import { volatileSessionTabTargetKey, volatileTabsBySession } from "./session-tab-process-state.js";
import {
  cdpMocks,
  clearProcessLocalTabState,
  setBrowserProfileConfig,
  installSessionTabRegistrySqliteHarness,
} from "./session-tab-registry.sqlite.test-harness.js";
import {
  type DurableRecord,
  type RegistryModule,
  durableOwnership as ownership,
} from "./session-tab-registry.sqlite.test-helpers.js";

const owner = { sessionKey: "agent:main:own", targetId: "NATIVE-OWN", profile: "remote" };
const main = { sessionKey: "agent:main:main", profile: "remote" };
const targetRows = (...targetIds: string[]) => targetIds.map((targetId) => ({ targetId }));
type BoundStore = PluginStateKeyedStore<unknown, 2>;
type InterceptStore = (store: BoundStore) => Partial<BoundStore>;
type TrackOptions = Parameters<RegistryModule["trackSessionBrowserTab"]>[0];
type CloseOptions = Parameters<RegistryModule["closeTrackedBrowserTabsForSessions"]>[0];
function interceptCurrent(store: PluginStateKeyedStore<unknown>, intercept: InterceptStore) {
  const bind = store.withCurrent;
  if (!bind) {
    throw new Error("Expected the real worker comparison store");
  }
  return (authority: Parameters<typeof bind>[0]) => {
    const bound = bind(authority);
    return { ...bound, ...intercept(bound) };
  };
}
function observeCurrent(intercept: InterceptStore) {
  const store = getBrowserStateRuntime().sessionTabs;
  const intercepted = interceptCurrent(store, intercept);
  return vi.spyOn(store, "withCurrent").mockImplementation(intercepted);
}
function requester() {
  let current = true;
  return {
    expire: () => {
      current = false;
    },
    authority: {
      runtime: getBrowserStateRuntime(),
      assertCurrent: () => {
        if (!current) {
          throw new Error("requester expired");
        }
      },
    },
  };
}

describe("session tab membership and lifecycle", () => {
  const { openStore, freshRegistry, installRuntime } = installSessionTabRegistrySqliteHarness();
  const installIntercepted = (intercept: InterceptStore) =>
    installRuntime((options) => {
      const store = createPluginStateKeyedStoreForTests("browser", options);
      return { ...store, withCurrent: interceptCurrent(store, intercept) };
    });
  async function session(label: string, identity: { sessionKey: string; profile?: string } = main) {
    const registry = await freshRegistry(label);
    return {
      registry,
      track: (targetId: string, nativeTargetId?: string, options: TrackOptions = {}) =>
        registry.trackSessionBrowserTab({
          ...identity,
          targetId,
          ...(nativeTargetId ? { ownership: ownership(nativeTargetId) } : {}),
          ...options,
        }),
      close: (options: Omit<CloseOptions, "sessionKeys"> & SessionEntryCurrentPreparation = {}) =>
        registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: [identity.sessionKey],
          ...options,
        }),
    };
  }

  it("reads session membership through the worker without changing rows, activity, or aliases", async () => {
    const identity = { sessionKey: "agent:main:own", profile: "resolved" };
    const { registry, track } = await session("membership", identity);
    await track("opaque-own", "NATIVE-OWN", {
      aliases: ["t1", "docs"],
      profileAliases: ["requested"],
      now: 1_000,
    });
    for (const profile of ["resolved", "other"]) {
      await track(`opaque-${profile}`, `NATIVE-${profile}`, {
        sessionKey: "agent:main:other",
        aliases: ["t1"],
        profile,
        now: 1_000,
      });
    }
    for (const targetId of ["volatile-own", "volatile-stale"]) {
      await track(targetId, undefined, {
        aliases: [`alias-${targetId}`],
        profileAliases: ["requested"],
        now: 1_000,
      });
    }
    const staleIdentity = {
      ...identity,
      targetId: "volatile-stale",
      route: { kind: "browser-control" } as const,
    };
    // A discovery read must not repair a stale process-local alias.
    volatileTabsBySession()
      .get(identity.sessionKey)
      ?.delete(volatileSessionTabTargetKey(staleIdentity));
    const durableAlias = { ...identity, targetId: "docs" };
    const volatileAlias = { ...identity, targetId: "alias-volatile-own" };
    const staleAlias = { ...identity, targetId: "alias-volatile-stale" };
    const aliases = () => [
      readDurableTabAlias(durableAlias).target,
      ...[volatileAlias, staleAlias].map((alias) => readVolatileTabAlias(alias).target),
    ];
    const aliasesBefore = aliases();
    expect(aliasesBefore.every(Boolean)).toBe(true);
    const volatileBefore = structuredClone(volatileTabsBySession());
    openStore().register("invalid-record", { version: 999 });
    openStore().register("wrong-storage-key", {
      version: 1,
      sessionKey: identity.sessionKey,
      nativeTargetId: "NATIVE-WRONG-KEY",
      profile: "resolved",
      profileAliases: ["requested"],
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      interactionTargetKind: "native",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    } satisfies DurableRecord);
    const before = openStore().entries();
    const ownedTabs = [
      { targetId: "NATIVE-OWN", tabId: "t1" },
      ...targetRows("opaque-own", "docs"),
      { targetId: "opaque-listed", tabId: "t1" },
      ...targetRows("volatile-own", "alias-volatile-own"),
    ];
    const tabs = [
      ...ownedTabs,
      ...targetRows(
        "NATIVE-resolved",
        "NATIVE-other",
        "NATIVE-WRONG-KEY",
        "alias-volatile-stale",
        "untracked",
      ),
    ];
    const observation = observeHostDataSql();
    try {
      for (const profile of ["resolved", "requested"]) {
        await expect(
          registry.filterTrackedSessionBrowserTabs({ sessionKey: "Agent:Main:Own", profile, tabs }),
        ).resolves.toEqual(ownedTabs);
      }
      await expect(
        registry.filterTrackedSessionBrowserTabs({ ...identity, profile: "other", tabs }),
      ).resolves.toEqual([]);
      expect(volatileTabsBySession()).toEqual(volatileBefore);
      expect(aliases()).toEqual(aliasesBefore);

      clearProcessLocalTabState();
      await expect(
        registry.filterTrackedSessionBrowserTabs({ ...identity, profile: "requested", tabs }),
      ).resolves.toEqual([ownedTabs[0]]);
    } finally {
      observation.restore();
    }
    expect(observation.queries).toEqual([]);
    expect(openStore().entries()).toEqual(before);
  });

  it("rejects membership when requester authority expires during the worker read", async () => {
    const { registry, track } = await session("membership-authority", owner);
    await track(owner.targetId, owner.targetId);
    const readCompleted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const observer = observeCurrent((store) => ({
      entries: async () => {
        const entries = await store.entries();
        readCompleted.resolve();
        await releaseRead.promise;
        return entries;
      },
    }));
    const caller = requester();
    const reading = registry.filterTrackedSessionBrowserTabs({
      ...owner,
      tabs: targetRows(owner.targetId),
      authority: caller.authority,
    });
    try {
      await readCompleted.promise;
      caller.expire();
      const rejected = expect(reading).rejects.toThrow("requester expired");
      releaseRead.resolve();
      await rejected;
    } finally {
      releaseRead.resolve();
      await Promise.allSettled([reading]);
      observer.mockRestore();
    }
  });

  it.each([
    { operation: "open", committed: false },
    { operation: "touch", committed: false },
    { operation: "untrack", committed: false },
    { operation: "open", committed: true },
  ] as const)(
    "settles helper $operation with expired requester authority (committed=$committed)",
    async ({ operation, committed }) => {
      const { registry, track } = await session(
        `helper-authority-${operation}-${committed}`,
        owner,
      );
      if (operation !== "open") {
        await track(owner.targetId, owner.targetId, { now: 1_000 });
      }
      const before = openStore().entries();
      const commitReached = createDeferred<void>();
      const releaseCommit = createDeferred<void>();
      const observer = observeCurrent((store) => ({
        compareAndApply: async (key, comparison, intent) => {
          const result = committed
            ? await store.compareAndApply(key, comparison, intent)
            : undefined;
          commitReached.resolve();
          await releaseCommit.promise;
          return result ?? (await store.compareAndApply(key, comparison, intent));
        },
      }));
      const caller = requester();
      const tabs = createBrowserToolSessionTabs({
        sessionKey: owner.sessionKey,
        requestedProfile: owner.profile,
        defaultProfile: owner.profile,
        registry,
        authority: caller.authority,
      });
      const closeTab = vi.fn(async () => {});
      const pending =
        operation === "open"
          ? tabs.trackOpened(
              {
                targetId: owner.targetId,
                resolvedProfile: owner.profile,
                ownership: ownership(owner.targetId),
              },
              closeTab,
            )
          : tabs[operation](owner.targetId);
      try {
        await commitReached.promise;
        caller.expire();
        const outcome = committed
          ? expect(pending).resolves.toBeUndefined()
          : expect(pending).rejects.toThrow("requester expired");
        releaseCommit.resolve();
        await outcome;
      } finally {
        releaseCommit.resolve();
        await Promise.allSettled([pending]);
        observer.mockRestore();
      }
      if (committed) {
        expect(openStore().entries()).toEqual([
          expect.objectContaining({
            value: expect.objectContaining({ nativeTargetId: owner.targetId }),
          }),
        ]);
      } else {
        expect(openStore().entries()).toEqual(before);
      }
      if (operation === "open" && !committed) {
        expect(closeTab).toHaveBeenCalledExactlyOnceWith(owner.targetId, owner.profile);
      } else {
        expect(closeTab).not.toHaveBeenCalled();
      }
    },
  );
  it.each(["lifecycle", "sweep"] as const)(
    "does not adopt a replacement volatile registration while %s cleanup prepares",
    async (kind) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let holdRead = false;
      await installIntercepted((store) => ({
        entries: async () => {
          const rows = await store.entries();
          if (holdRead) {
            holdRead = false;
            entered.resolve();
            await release.promise;
          }
          return rows;
        },
      }));
      const { registry, track, close } = await session(`replacement-during-${kind}-preparation`, {
        sessionKey: main.sessionKey,
      });
      const tab = {
        sessionKey: "agent:main:main",
        targetId: "replaced-tab",
        route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const,
      };
      await track(tab.targetId, undefined, { route: tab.route, now: 1_000 });
      const closeTab = vi.fn(async () => {});
      const cleanup = () =>
        kind === "lifecycle"
          ? close({ closeTab })
          : registry.sweepTrackedBrowserTabs({ now: 2_000, idleMs: 1_000, closeTab });
      holdRead = true;
      const pending = cleanup();
      try {
        await entered.promise;
        await registry.untrackSessionBrowserTab(tab);
        await track(tab.targetId, undefined, { route: tab.route, now: 1_000 });
        release.resolve();
        await expect(pending).resolves.toBe(0);
        expect(closeTab).not.toHaveBeenCalled();
        await expect(cleanup()).resolves.toBe(1);
        expect(closeTab).toHaveBeenCalledOnce();
      } finally {
        release.resolve();
        await pending;
      }
    },
  );

  it.each(["successful", "failed"] as const)(
    "closes a durable tab after reopening with a %s initial store read",
    async (initialRead) => {
      setBrowserProfileConfig();
      const { track } = await session("first", {
        sessionKey: "Agent:Main:Main",
        profile: "Remote",
      });
      await track("interaction-target", "NATIVE-1", {
        profileAliases: ["remote-alias"],
        now: 1_000,
      });
      expect(openStore().entries()).toHaveLength(1);

      resetPluginStateStoreForTests();
      clearProcessLocalTabState();
      if (initialRead === "failed") {
        const error = new Error("initial worker read failed");
        let failed = false;
        await expect(
          installIntercepted((store) => ({
            entries: async () => {
              if (!failed) {
                failed = true;
                throw error;
              }
              return await store.entries();
            },
          })),
        ).rejects.toBe(error);
      } else {
        await installRuntime();
      }
      const { registry: restarted, close } = await session("restarted");
      await restarted.touchSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "NATIVE-1",
        profile: "remote-alias",
        now: 2_000,
      });
      expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 2_000 });

      await expect(close()).resolves.toBe(1);
      expect(cdpMocks.closeTrackedCdpTarget).toHaveBeenCalledWith({
        profileName: "remote",
        cdpUrl: "http://127.0.0.1:9222",
        nativeTargetId: "NATIVE-1",
        timeoutMs: expect.any(Number),
        ssrfPolicy: expect.any(Object),
        expectedProfileFingerprint: "test-profile-fingerprint",
        expectedBrowserInstanceFingerprint: "test-browser-instance-fingerprint",
        closeIfCurrent: expect.any(Function),
      });
      expect(openStore().entries()).toEqual([]);
    },
  );

  it.each(
    (["durable", "volatile"] as const).flatMap((kind) =>
      (["synchronous", "prepared"] as const).map((guard) => ({ kind, guard })),
    ),
  )(
    "settles admitted $kind cleanup but stops new claims after its $guard caller changes",
    async ({ kind, guard }) => {
      const sessionKey = "agent:subagent:ended";
      const { track, close } = await session(`caller-generation-${kind}`, { ...main, sessionKey });
      for (const targetId of ["tab-a", "tab-b"]) {
        await track(
          targetId,
          kind === "durable" ? targetId : undefined,
          kind === "volatile"
            ? { route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } }
            : {},
        );
      }
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      let current = true;
      const closeTab = vi.fn(async (_tab: { targetId: string }) => {
        started.resolve();
        await finish.promise;
      });
      const closeDurableTab: NonNullable<CloseOptions["closeDurableTab"]> = async (tab, options) =>
        await options.closeIfCurrent(async () => {
          await closeTab({ targetId: tab.nativeTargetId });
          return { status: "closed" };
        });
      const cleanup = close({
        isCurrent: () => guard === "prepared" || current,
        ...(guard === "prepared" ? { prepareCurrent: async () => current } : {}),
        closeTab,
        closeDurableTab,
      });
      try {
        await started.promise;
        current = false;
        finish.resolve();
        await expect(cleanup).resolves.toBe(1);
        expect(closeTab).toHaveBeenCalledOnce();
        if (kind === "durable") {
          expect(openStore().entries()).toHaveLength(1);
          expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
        }
        await expect(close({ closeTab, closeDurableTab })).resolves.toBe(1);
        expect(closeTab.mock.calls.map(([tab]) => tab.targetId).toSorted()).toEqual([
          "tab-a",
          "tab-b",
        ]);
        expect(openStore().entries()).toEqual([]);
      } finally {
        finish.resolve();
        await cleanup;
      }
    },
  );

  it.each([true, false])(
    "retries pending lifecycle cleanup with ordinary cleanup %s",
    async (ordinaryCleanup) => {
      const { registry, track, close } = await session("lifecycle-retry", {
        ...main,
        sessionKey: "agent:subagent:ended",
      });
      await track("opaque", "NATIVE-PENDING", { now: 1_000 });
      await expect(
        close({
          now: 2_000,
          closeDurableTab: async () => ({ status: "unavailable", reason: "target-lookup-failed" }),
        }),
      ).resolves.toBe(0);
      expect(openStore().entries()[0]?.value).toMatchObject({
        nativeTargetId: "NATIVE-PENDING",
        cleanupKind: "lifecycle",
        cleanupAttemptToken: expect.any(String),
      });
      await track("active", "NATIVE-ACTIVE", {
        sessionKey: "agent:main:active",
        now: 1_000,
      });

      await expect(
        registry.sweepTrackedBrowserTabs({
          now: 10_000,
          ordinaryCleanup,
          sessionFilter: () => false,
          closeDurableTab: async (_tab, options) =>
            await options.closeIfCurrent(async () => ({ status: "closed" })),
        }),
      ).resolves.toBe(1);
      expect(
        openStore()
          .entries()
          .map((entry) => entry.value),
      ).toEqual([expect.objectContaining({ nativeTargetId: "NATIVE-ACTIVE" })]);
    },
  );

  it("converges after close succeeds but the first durable delete fails", async () => {
    let failDelete = true;
    await installIntercepted((store) => ({
      compareAndApply: async (key, comparison, intent) => {
        if (intent.action === "delete" && failDelete) {
          failDelete = false;
          throw new Error("delete unavailable");
        }
        return await store.compareAndApply(key, comparison, intent);
      },
    }));
    const { track, close } = await session("delete-failure");
    await track("tab-a", "NATIVE-A");
    await close({ closeDurableTab: async () => ({ status: "closed" }) });
    expect(openStore().entries()).toHaveLength(1);

    resetPluginStateStoreForTests();
    await installRuntime();
    const restarted = await session("delete-failure-restart");
    await restarted.close({ closeDurableTab: async () => ({ status: "missing" }) });
    expect(openStore().entries()).toEqual([]);
  });
});
