// Session membership and requester authority use the real worker-backed registry.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserToolSessionTabs } from "../browser-tool-session-tabs.js";
import {
  resolveDurableTabAlias,
  resolveVolatileTabAlias,
} from "./session-tab-ephemeral-aliases.js";
import { volatileSessionTabTargetKey, volatileTabsBySession } from "./session-tab-process-state.js";
import {
  clearProcessLocalTabState,
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
      resolveDurableTabAlias(durableAlias),
      resolveVolatileTabAlias(volatileAlias),
      resolveVolatileTabAlias(staleAlias),
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
        resolveDurableTabAlias(durableAlias),
        resolveVolatileTabAlias(volatileAlias),
        resolveVolatileTabAlias(staleAlias),
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
