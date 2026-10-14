// Session membership and requester authority use the real worker-backed registry.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
  durableOwnership as ownership,
} from "./session-tab-registry.sqlite.test-helpers.js";

describe("session tab membership", () => {
  const { openStore, freshRegistry } = installSessionTabRegistrySqliteHarness();

  it("reads session membership through the worker without changing rows, activity, or aliases", async () => {
    const registry = await freshRegistry("membership");
    const identity = { sessionKey: "agent:main:own", profile: "resolved" };
    await registry.trackSessionBrowserTab({
      ...identity,
      targetId: "opaque-own",
      aliases: ["t1", "docs"],
      profileAliases: ["requested"],
      ownership: ownership("NATIVE-OWN"),
      now: 1_000,
    });
    for (const profile of ["resolved", "other"]) {
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:main:other",
        targetId: `opaque-${profile}`,
        aliases: ["t1"],
        profile,
        ownership: ownership(`NATIVE-${profile}`),
        now: 1_000,
      });
    }
    for (const targetId of ["volatile-own", "volatile-stale"]) {
      await registry.trackSessionBrowserTab({
        ...identity,
        targetId,
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
    const aliasesBefore = [
      readDurableTabAlias(durableAlias).target,
      readVolatileTabAlias(volatileAlias).target,
      readVolatileTabAlias(staleAlias).target,
    ];
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
      { targetId: "opaque-own" },
      { targetId: "docs" },
      { targetId: "opaque-listed", tabId: "t1" },
      { targetId: "volatile-own" },
      { targetId: "alias-volatile-own" },
    ];
    const tabs = [
      ...ownedTabs,
      { targetId: "NATIVE-resolved" },
      { targetId: "NATIVE-other" },
      { targetId: "NATIVE-WRONG-KEY" },
      { targetId: "alias-volatile-stale" },
      { targetId: "untracked" },
    ];
    const observation = observeHostDataSql();
    try {
      for (const profile of ["resolved", "requested"]) {
        await expect(
          registry.filterTrackedSessionBrowserTabs({
            sessionKey: "Agent:Main:Own",
            profile,
            tabs,
          }),
        ).resolves.toEqual(ownedTabs);
      }
      await expect(
        registry.filterTrackedSessionBrowserTabs({
          ...identity,
          profile: "other",
          tabs,
        }),
      ).resolves.toEqual([]);
      expect(volatileTabsBySession()).toEqual(volatileBefore);
      expect([
        readDurableTabAlias(durableAlias).target,
        readVolatileTabAlias(volatileAlias).target,
        readVolatileTabAlias(staleAlias).target,
      ]).toEqual(aliasesBefore);

      clearProcessLocalTabState();
      await expect(
        registry.filterTrackedSessionBrowserTabs({
          ...identity,
          profile: "requested",
          tabs,
        }),
      ).resolves.toEqual([ownedTabs[0]]);
    } finally {
      observation.restore();
    }
    expect(observation.queries).toEqual([]);
    expect(openStore().entries()).toEqual(before);
  });

  it("rejects membership when requester authority expires during the worker read", async () => {
    const registry = await freshRegistry("membership-authority");
    const identity = {
      sessionKey: "agent:main:own",
      targetId: "NATIVE-OWN",
      profile: "remote",
    };
    await registry.trackSessionBrowserTab({ ...identity, ownership: ownership(identity.targetId) });
    const runtime = getBrowserStateRuntime();
    const bind = runtime.sessionTabs.withCurrent;
    if (!bind) {
      throw new Error("Expected the real worker comparison store");
    }
    const readCompleted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const observer = vi
      .spyOn(runtime.sessionTabs, "withCurrent")
      .mockImplementation((authority) => {
        const store = bind(authority);
        return {
          ...store,
          entries: async () => {
            const entries = await store.entries();
            readCompleted.resolve();
            await releaseRead.promise;
            return entries;
          },
        };
      });
    let current = true;
    const reading = registry.filterTrackedSessionBrowserTabs({
      ...identity,
      tabs: [{ targetId: identity.targetId }],
      authority: {
        runtime,
        assertCurrent: () => {
          if (!current) {
            throw new Error("requester expired");
          }
        },
      },
    });
    try {
      await readCompleted.promise;
      current = false;
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
      const registry = await freshRegistry(`helper-authority-${operation}-${committed}`);
      const identity = {
        sessionKey: "agent:main:own",
        targetId: "NATIVE-OWN",
        profile: "remote",
      };
      if (operation !== "open") {
        await registry.trackSessionBrowserTab({
          ...identity,
          ownership: ownership(identity.targetId),
          now: 1_000,
        });
      }
      const before = openStore().entries();
      const runtime = getBrowserStateRuntime();
      const bind = runtime.sessionTabs.withCurrent;
      if (!bind) {
        throw new Error("Expected the real worker comparison store");
      }
      const commitReached = createDeferred<void>();
      const releaseCommit = createDeferred<void>();
      const observer = vi
        .spyOn(runtime.sessionTabs, "withCurrent")
        .mockImplementation((authority) => {
          const store = bind(authority);
          return {
            ...store,
            compareAndApply: async (key, comparison, intent) => {
              const result = committed
                ? await store.compareAndApply(key, comparison, intent)
                : undefined;
              commitReached.resolve();
              await releaseCommit.promise;
              return result ?? (await store.compareAndApply(key, comparison, intent));
            },
          };
        });
      let current = true;
      const tabs = createBrowserToolSessionTabs({
        sessionKey: identity.sessionKey,
        requestedProfile: identity.profile,
        defaultProfile: identity.profile,
        registry,
        authority: {
          runtime,
          assertCurrent: () => {
            if (!current) {
              throw new Error("requester expired");
            }
          },
        },
      });
      const closeTab = vi.fn(async () => {});
      const pending =
        operation === "open"
          ? tabs.trackOpened(
              {
                targetId: identity.targetId,
                resolvedProfile: identity.profile,
                ownership: ownership(identity.targetId),
              },
              closeTab,
            )
          : tabs[operation](identity.targetId);
      try {
        await commitReached.promise;
        current = false;
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
            value: expect.objectContaining({ nativeTargetId: identity.targetId }),
          }),
        ]);
      } else {
        expect(openStore().entries()).toEqual(before);
      }
      if (operation === "open" && !committed) {
        expect(closeTab).toHaveBeenCalledExactlyOnceWith(identity.targetId, identity.profile);
      } else {
        expect(closeTab).not.toHaveBeenCalled();
      }
    },
  );
});

describe("session tab lifecycle cleanup", () => {
  const { freshRegistry, openStore, installRuntime } = installSessionTabRegistrySqliteHarness();

  it.each(["lifecycle", "sweep"] as const)(
    "does not adopt a replacement volatile registration while %s cleanup prepares",
    async (kind) => {
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let holdRead = false;
      await installRuntime((options) => {
        const store = createPluginStateKeyedStoreForTests("browser", options);
        return {
          ...store,
          withCurrent: (authority) => {
            const bound = store.withCurrent!(authority);
            return {
              ...bound,
              entries: async () => {
                const rows = await bound.entries();
                if (holdRead) {
                  holdRead = false;
                  entered.resolve();
                  await release.promise;
                }
                return rows;
              },
            };
          },
        };
      });
      const registry = await freshRegistry(`replacement-during-${kind}-preparation`);
      const tab = {
        sessionKey: "agent:main:main",
        targetId: "replaced-tab",
        route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const,
      };
      await registry.trackSessionBrowserTab({ ...tab, now: 1_000 });
      const closeTab = vi.fn(async () => {});
      const cleanup = () =>
        kind === "lifecycle"
          ? registry.closeTrackedBrowserTabsForSessions({
              sessionKeys: [tab.sessionKey],
              closeTab,
            })
          : registry.sweepTrackedBrowserTabs({ now: 2_000, idleMs: 1_000, closeTab });
      holdRead = true;
      const pending = cleanup();
      try {
        await entered.promise;
        await registry.untrackSessionBrowserTab(tab);
        await registry.trackSessionBrowserTab({ ...tab, now: 1_000 });
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
      const first = await freshRegistry("first");
      await first.trackSessionBrowserTab({
        sessionKey: "Agent:Main:Main",
        targetId: "interaction-target",
        profile: "Remote",
        profileAliases: ["remote-alias"],
        ownership: ownership("NATIVE-1"),
        now: 1_000,
      });
      expect(openStore().entries()).toHaveLength(1);

      resetPluginStateStoreForTests();
      clearProcessLocalTabState();
      if (initialRead === "failed") {
        const error = new Error("initial worker read failed");
        let failed = false;
        await expect(
          installRuntime((options) => {
            const store = createPluginStateKeyedStoreForTests("browser", options);
            return {
              ...store,
              withCurrent: (authority) => {
                const bound = store.withCurrent!(authority);
                return {
                  ...bound,
                  entries: async () => {
                    if (!failed) {
                      failed = true;
                      throw error;
                    }
                    return await bound.entries();
                  },
                };
              },
            };
          }),
        ).rejects.toBe(error);
      } else {
        await installRuntime();
      }
      const restarted = await freshRegistry("restarted");
      await restarted.touchSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "NATIVE-1",
        profile: "remote-alias",
        now: 2_000,
      });
      expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 2_000 });

      await expect(
        restarted.closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] }),
      ).resolves.toBe(1);
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
      const registry = await freshRegistry(`caller-generation-${kind}`);
      const sessionKey = "agent:subagent:ended";
      for (const targetId of ["tab-a", "tab-b"]) {
        await registry.trackSessionBrowserTab({
          sessionKey,
          targetId,
          profile: "remote",
          ...(kind === "durable"
            ? { ownership: ownership(targetId) }
            : { route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" } as const }),
        });
      }
      const started = createDeferred<void>();
      const finish = createDeferred<void>();
      let current = true;
      const closeTab = vi.fn(async (_tab: { targetId: string }) => {
        started.resolve();
        await finish.promise;
      });
      const closeDurableTab: NonNullable<
        Parameters<typeof registry.closeTrackedBrowserTabsForSessions>[0]["closeDurableTab"]
      > = async (tab, options) => {
        return await options.closeIfCurrent(async () => {
          await closeTab({ targetId: tab.nativeTargetId });
          return { status: "closed" };
        });
      };
      const cleanup = registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: [sessionKey],
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
        await expect(
          registry.closeTrackedBrowserTabsForSessions({
            sessionKeys: [sessionKey],
            closeTab,
            closeDurableTab,
          }),
        ).resolves.toBe(1);
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
      const registry = await freshRegistry("lifecycle-retry");
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:subagent:ended",
        targetId: "opaque",
        profile: "remote",
        ownership: ownership("NATIVE-PENDING"),
        now: 1_000,
      });
      await expect(
        registry.closeTrackedBrowserTabsForSessions({
          sessionKeys: ["agent:subagent:ended"],
          now: 2_000,
          closeDurableTab: async () => ({
            status: "unavailable",
            reason: "target-lookup-failed",
          }),
        }),
      ).resolves.toBe(0);
      expect(openStore().entries()[0]?.value).toMatchObject({
        nativeTargetId: "NATIVE-PENDING",
        cleanupKind: "lifecycle",
        cleanupAttemptToken: expect.any(String),
      });
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:main:active",
        targetId: "active",
        profile: "remote",
        ownership: ownership("NATIVE-ACTIVE"),
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
    await installRuntime((options) => {
      const store = createPluginStateKeyedStoreForTests("browser", options);
      return {
        ...store,
        withCurrent: (authority) => {
          const action = store.withCurrent(authority);
          return {
            ...action,
            compareAndApply: async (key, comparison, intent) => {
              if (intent.action === "delete" && failDelete) {
                failDelete = false;
                throw new Error("delete unavailable");
              }
              return await action.compareAndApply(key, comparison, intent);
            },
          };
        },
      };
    });
    const first = await freshRegistry("delete-failure");
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
    });
    await first.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeDurableTab: async () => ({ status: "closed" }),
    });
    expect(openStore().entries()).toHaveLength(1);

    resetPluginStateStoreForTests();
    await installRuntime();
    const restarted = await freshRegistry("delete-failure-restart");
    await restarted.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeDurableTab: async () => ({ status: "missing" }),
    });
    expect(openStore().entries()).toEqual([]);
  });
});
