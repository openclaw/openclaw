// Browser tests cover durable session tab cleanup through the real plugin-state store.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserToolSessionTabs } from "../browser-tool-session-tabs.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import { browserSessionTabStorageKey } from "./session-tab-identity.js";
import {
  clearProcessLocalTabState,
  installSessionTabRegistrySqliteHarness,
} from "./session-tab-registry.sqlite.test-harness.js";
import {
  type CloseTab,
  type CloseOptions,
  type DurableRecord,
  type DurableTab,
  type RegistryModule,
  durableOwnership as ownership,
} from "./session-tab-registry.sqlite.test-helpers.js";

const identity = (targetId: string, sessionKey = "agent:main:main", profile = "remote") => ({
  sessionKey,
  targetId,
  profile,
});
const owned = (
  targetId: string,
  nativeTargetId: string,
  options: Partial<Parameters<RegistryModule["trackSessionBrowserTab"]>[0]> = {},
) => ({ ...identity(targetId), ownership: ownership(nativeTargetId), ...options });
function record(nativeTargetId: string, overrides: Partial<DurableRecord> = {}): DurableRecord {
  return {
    version: 1,
    sessionKey: "agent:main:main",
    nativeTargetId,
    profile: "remote",
    profileFingerprint: "test-profile-fingerprint",
    browserInstanceFingerprint: "test-browser-instance-fingerprint",
    interactionTargetKind: "native",
    trackedAt: 1_000,
    lastUsedAt: 1_000,
    ...overrides,
  };
}

describe("durable session tab registry", () => {
  const { openStore, installRuntime, freshRegistry } = installSessionTabRegistrySqliteHarness();

  it.each(["volatile", "durable", "restarted"])(
    "keeps another agent's global tabs during %s cleanup",
    async (kind) => {
      const registry = await freshRegistry("agent-scope");
      for (const agentId of ["alpha", "beta"]) {
        const params = { agentId, sessionKey: "global", defaultProfile: "remote", registry };
        const tabs = createBrowserToolSessionTabs(params);
        await tabs.trackOpened(
          {
            targetId: `${agentId}-tab`,
            resolvedProfile: "remote",
            ...(kind === "volatile" ? {} : { ownership: ownership(`${agentId}-tab`) }),
          },
          async () => {},
        );
      }
      if (kind === "restarted") {
        clearProcessLocalTabState();
        await installRuntime();
      }
      const closed: string[] = [];
      const closeTab = async ({ targetId }: { targetId: string }) => {
        closed.push(targetId);
      };
      const closeDurableTab = async ({ nativeTargetId }: { nativeTargetId: string }) => {
        closed.push(nativeTargetId);
        return { status: "closed" as const };
      };
      await registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["global"],
        closeTab,
        closeDurableTab,
      });
      expect(closed).toEqual([]);
      await registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:alpha:global"],
        closeTab,
        closeDurableTab,
      });
      expect(closed).toEqual(["alpha-tab"]);
      await registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:beta:global"],
        closeTab,
        closeDurableTab,
      });
      expect(closed).toEqual(["alpha-tab", "beta-tab"]);
    },
  );

  it("prunes legacy raw ownership without adopting or closing its tabs", async () => {
    const registry = await freshRegistry("legacy-ownership");
    const legacy = record("legacy-tab", {
      sessionKey: "global",
      profileFingerprint: "profile",
      browserInstanceFingerprint: "browser",
      trackedAt: 0,
      lastUsedAt: 0,
    });
    const key = browserSessionTabStorageKey(legacy);
    openStore().register(key, legacy);
    const unknownRecord = { ...legacy, version: 999 };
    openStore().register("unknown-legacy", unknownRecord);
    clearProcessLocalTabState();
    await installRuntime();
    const closeDurableTab = vi.fn(async () => ({ status: "closed" as const }));
    expect(
      await registry.filterTrackedSessionBrowserTabs({
        sessionKey: "agent:alpha:global",
        profile: "remote",
        tabs: [{ targetId: "legacy-tab" }],
      }),
    ).toEqual([]);
    await registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["global", "agent:alpha:global"],
      closeDurableTab,
    });
    await registry.sweepTrackedBrowserTabs({ now: 1000, idleMs: 1, closeDurableTab });
    expect(closeDurableTab).not.toHaveBeenCalled();
    expect(openStore().lookup(key)).toBeUndefined();
    expect(openStore().lookup("unknown-legacy")).toBeUndefined();
  });

  it("does not publish volatile ownership after its hydrated runtime is replaced", async () => {
    const registry = await freshRegistry("volatile-runtime-replacement");
    const tracking = registry.trackSessionBrowserTab(identity("stale-volatile"));
    const replacement = Promise.resolve().then(() => installRuntime());
    try {
      await expect(tracking).rejects.toThrow("Browser session tab store owner changed");
    } finally {
      await Promise.allSettled([tracking, replacement]);
    }
    const closeTab = vi.fn<CloseTab>(async () => {});
    expect(
      await registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("keeps browser-bridge aliases isolated from host-browser durable records", async () => {
    const registry = await freshRegistry("bridge-alias-isolation");
    await registry.trackSessionBrowserTab(owned("shared-target", "NATIVE-HOST", { now: 1_000 }));
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
      ownership: ownership("NATIVE-BRIDGE"),
      now: 2_000,
    });

    await registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
      now: 3_000,
    });
    await registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
    });

    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-HOST",
      lastUsedAt: 1_000,
    });
  });

  it("prefers an exact durable target over a volatile alias while untracking", async () => {
    const registry = await freshRegistry("durable-exact-over-volatile-alias");
    await registry.trackSessionBrowserTab(
      owned("DURABLE-NATIVE", "DURABLE-NATIVE", { now: 1_000 }),
    );

    clearProcessLocalTabState();
    await installRuntime();
    const restarted = await freshRegistry("durable-exact-over-volatile-alias-restarted");
    await restarted.trackSessionBrowserTab({
      ...identity("VOLATILE-RAW"),
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      aliases: ["DURABLE-NATIVE"],
      now: 2_000,
    });

    await restarted.untrackSessionBrowserTab(identity("DURABLE-NATIVE"));
    expect(openStore().entries()).toEqual([]);

    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      restarted.closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"], closeTab }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "VOLATILE-RAW",
      baseUrl: undefined,
      profile: "remote",
    });
  });

  it("prefers an exact volatile target over a durable alias while untracking", async () => {
    const registry = await freshRegistry("volatile-exact-over-durable-alias");
    await registry.trackSessionBrowserTab({
      ...identity("DURABLE-OPAQUE"),
      ownership: ownership("DURABLE-NATIVE"),
      aliases: ["VOLATILE-RAW"],
      now: 1_000,
    });
    await registry.trackSessionBrowserTab({
      ...identity("VOLATILE-RAW"),
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      now: 2_000,
    });

    await registry.untrackSessionBrowserTab(identity("VOLATILE-RAW"));
    expect(openStore().entries()).toHaveLength(1);

    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(closeDurableTab).toHaveBeenCalledWith(
      expect.objectContaining({ nativeTargetId: "DURABLE-NATIVE" }),
      expect.objectContaining({ closeIfCurrent: expect.any(Function) }),
    );
  });

  it("keeps durable ownership when volatile exact profile aliases are ambiguous", async () => {
    const registry = await freshRegistry("cross-kind-exact-ambiguity");
    await registry.trackSessionBrowserTab({
      ...identity("SHARED-NATIVE", "agent:main:main", "requested-profile"),
      ownership: ownership("SHARED-NATIVE"),
      now: 1_000,
    });
    for (const profile of ["resolved-a", "resolved-b"]) {
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "SHARED-NATIVE",
        profile,
        profileAliases: ["requested-profile"],
        ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
        now: 2_000,
      });
    }

    await registry.untrackSessionBrowserTab(
      identity("SHARED-NATIVE", "agent:main:main", "requested-profile"),
    );
    expect(openStore().entries()).toHaveLength(1);

    const closeTab = vi.fn<CloseTab>(async () => {});
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
        closeDurableTab,
      }),
    ).resolves.toBe(3);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeDurableTab).toHaveBeenCalledOnce();
  });

  it("fails closed when resolved-profile aliases collide", async () => {
    const registry = await freshRegistry("resolved-profile-collision");
    for (const [profile, nativeTargetId] of [
      ["resolved-a", "browser-a"],
      ["resolved-b", "browser-b"],
    ] as const) {
      await registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "NATIVE-SHARED",
        profile,
        profileAliases: ["requested-profile"],
        ownership: ownership("NATIVE-SHARED", `profile-${profile}`, nativeTargetId),
        now: 1_000,
      });
    }

    clearProcessLocalTabState();
    await installRuntime();
    const restarted = await freshRegistry("resolved-profile-collision-restarted");

    await restarted.touchSessionBrowserTab({
      ...identity("NATIVE-SHARED", "agent:main:main", "requested-profile"),
      now: 9_000,
    });
    expect(
      openStore()
        .entries()
        .map((entry) => entry.value),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserInstanceFingerprint: "browser-a", lastUsedAt: 1_000 }),
        expect.objectContaining({ browserInstanceFingerprint: "browser-b", lastUsedAt: 1_000 }),
      ]),
    );

    await restarted.untrackSessionBrowserTab(
      identity("NATIVE-SHARED", "agent:main:main", "resolved-b"),
    );
    await restarted.touchSessionBrowserTab({
      ...identity("NATIVE-SHARED", "agent:main:main", "requested-profile"),
      now: 10_000,
    });
    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      browserInstanceFingerprint: "browser-a",
      lastUsedAt: 10_000,
    });
  });

  it("keeps identical native ids isolated across browser instances", async () => {
    const first = await freshRegistry("browser-instance-collision-first");
    await first.trackSessionBrowserTab({
      ...identity("NATIVE-SHARED", "agent:main:collision"),
      ownership: ownership("NATIVE-SHARED", "profile-a", "browser-a"),
      now: 1_000,
    });
    await first.trackSessionBrowserTab({
      ...identity("NATIVE-SHARED", "agent:main:collision"),
      ownership: ownership("NATIVE-SHARED", "profile-b", "browser-b"),
      now: 2_000,
    });
    expect(openStore().entries()).toHaveLength(2);

    clearProcessLocalTabState();
    const restarted = await freshRegistry("browser-instance-collision-restarted");
    await restarted.touchSessionBrowserTab({
      ...identity("NATIVE-SHARED", "agent:main:collision"),
      now: 10_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeDurableTab }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
    expect(
      openStore()
        .entries()
        .map((entry) => (entry.value as DurableRecord).lastUsedAt)
        .toSorted((left, right) => left - right),
    ).toEqual([1_000, 2_000]);
  });

  it("fails closed at capacity without evicting an existing ownership record", async () => {
    const registry = await freshRegistry("capacity");
    const store = openStore();
    for (let index = 0; index < 5_000; index += 1) {
      const row = record(`NATIVE-${index}`, {
        interactionTargetKind: "opaque",
        trackedAt: index + 1,
        lastUsedAt: index + 1,
      });
      store.register(browserSessionTabStorageKey(row), row);
    }
    await expect(
      registry.trackSessionBrowserTab(owned("tab-5000", "NATIVE-5000", { now: 5_001 })),
    ).rejects.toThrow(/5000-row limit/);

    const records = openStore()
      .entries()
      .map((entry) => entry.value as DurableRecord);
    expect(records).toHaveLength(5_000);
    expect(records.some((row) => row.nativeTargetId === "NATIVE-0")).toBe(true);
    expect(records.some((row) => row.nativeTargetId === "NATIVE-4999")).toBe(true);
    expect(records.some((row) => row.nativeTargetId === "NATIVE-5000")).toBe(false);
  });

  it("keeps transient close failures and retires terminal outcomes", async () => {
    const registry = await freshRegistry("outcomes");
    for (const target of ["closed", "missing", "mismatch", "unavailable"]) {
      await registry.trackSessionBrowserTab({
        sessionKey: `agent:main:${target}`,
        targetId: target,
        profile: "remote",
        ownership: ownership(`NATIVE-${target}`),
      });
    }
    const outcomeByTarget: Record<string, CloseTrackedCdpTargetResult> = {
      "NATIVE-closed": { status: "closed" },
      "NATIVE-missing": { status: "missing" },
      "NATIVE-mismatch": { status: "ownership-mismatch" },
      "NATIVE-unavailable": { status: "unavailable", reason: "target-lookup-failed" },
    };
    const closeDurableTab = vi.fn(async (tab: DurableTab) => outcomeByTarget[tab.nativeTargetId]!);

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:closed", "agent:main:missing", "agent:main:mismatch"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:unavailable"],
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(
      openStore()
        .entries()
        .map((entry) => (entry.value as DurableRecord).nativeTargetId),
    ).toEqual(["NATIVE-unavailable"]);
  });

  it("warns once per deferred durable tab and keeps repeated deferrals at debug level", async () => {
    const registry = await freshRegistry("deferred-warning-bound");
    const tracked = 1_000;
    await registry.trackSessionBrowserTab({
      ...identity("gone"),
      ownership: ownership("NATIVE-gone"),
      now: tracked,
    });
    const warnings: string[] = [];
    const debugDiagnostics: string[] = [];
    let reason: "browser-identity-lookup-failed" | "browser-identity-unavailable" =
      "browser-identity-lookup-failed";
    const closeDurableTab = async (): Promise<CloseTrackedCdpTargetResult> => ({
      status: "unavailable",
      reason,
    });
    const deferred = (value: string) => `deferred tracked browser tab NATIVE-gone: ${value}`;
    const sweepAt = (now: number) =>
      registry.sweepTrackedBrowserTabs({
        now,
        idleMs: 1,
        closeDurableTab,
        onWarn: (message) => warnings.push(message),
        onDebug: (message) => debugDiagnostics.push(message),
      });

    // A stopped managed browser stays unreachable across many five-minute sweeps.
    await sweepAt(tracked + 1);
    await sweepAt(tracked + 2);
    await sweepAt(tracked + 3);
    expect(warnings).toEqual([deferred("browser-identity-lookup-failed")]);
    expect(debugDiagnostics).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-lookup-failed"),
    ]);
    // The reminder is demoted, not dropped: retries and the pending row survive.
    expect(openStore().entries()).toHaveLength(1);

    // A different unreachable reason is a new condition and warns again.
    reason = "browser-identity-unavailable";
    await sweepAt(tracked + 4);
    expect(warnings).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-unavailable"),
    ]);

    // The documented retire window still ends the deferral with a single warning.
    await sweepAt(tracked + BROWSER_TAB_UNREACHABLE_RETIRE_MS);
    expect(warnings).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-unavailable"),
      "retired unreachable tracked browser tab NATIVE-gone: browser-identity-unavailable",
    ]);
    expect(openStore().entries()).toEqual([]);
  });

  it("warns again when a settled durable tab is retracked and deferred anew", async () => {
    const registry = await freshRegistry("deferred-warning-recurrence");
    const tracked = 1_000;
    const track = (now: number) =>
      registry.trackSessionBrowserTab({
        ...identity("gone"),
        ownership: ownership("NATIVE-recur"),
        now,
      });
    const warnings: string[] = [];
    const deferred = "deferred tracked browser tab NATIVE-recur: browser-identity-lookup-failed";
    const sweepAt = (now: number, closeDurableTab: () => Promise<CloseTrackedCdpTargetResult>) =>
      registry.sweepTrackedBrowserTabs({
        now,
        idleMs: 1,
        closeDurableTab,
        onWarn: (message) => warnings.push(message),
      });
    const unreachable = async (): Promise<CloseTrackedCdpTargetResult> => ({
      status: "unavailable",
      reason: "browser-identity-lookup-failed",
    });

    await track(tracked);
    await sweepAt(tracked + 1, unreachable);
    await sweepAt(tracked + 2, unreachable);
    expect(warnings).toEqual([deferred]);

    // The browser recovered and the deferred row settled, so its bound must reset.
    await sweepAt(tracked + 3, async () => ({ status: "closed" }));
    expect(openStore().entries()).toEqual([]);

    await track(tracked + 4);
    await sweepAt(tracked + 5, unreachable);
    expect(warnings).toEqual([deferred, deferred]);
  });

  it("keeps an old unreachable row when activity revokes its retirement claim", async () => {
    const registry = await freshRegistry("unreachable-touch-race");
    const tracked = 1_000;
    const sweepNow = tracked + BROWSER_TAB_UNREACHABLE_RETIRE_MS;
    await registry.trackSessionBrowserTab({
      ...identity("gone"),
      ownership: ownership("NATIVE-gone"),
      now: tracked,
    });

    await registry.sweepTrackedBrowserTabs({
      now: sweepNow,
      idleMs: 1,
      closeDurableTab: async (_tab, options) => {
        await registry.touchSessionBrowserTab({ ...identity("gone"), now: sweepNow });
        const dispatch = vi.fn(async () => ({ status: "closed" as const }));
        await expect(options.closeIfCurrent(dispatch)).resolves.toEqual({ status: "cancelled" });
        expect(dispatch).not.toHaveBeenCalled();
        return { status: "unavailable", reason: "browser-identity-lookup-failed" };
      },
    });

    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: sweepNow });
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
  });

  it("cancels an in-flight sweep when the tab becomes active before close", async () => {
    const registry = await freshRegistry("sweep-touch-race");
    await registry.trackSessionBrowserTab({
      ...identity("opaque"),
      ownership: ownership("NATIVE-RACE"),
      aliases: ["opaque", "docs"],
      now: 1_000,
    });
    const started = createDeferred<void>();
    const closeGate = createDeferred<void>();
    const closeDurableTab = vi.fn(async (_tab: DurableTab, options: CloseOptions) => {
      started.resolve();
      await closeGate.promise;
      return await options.closeIfCurrent(async () => ({ status: "closed" }));
    });

    const sweep = registry.sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeDurableTab });
    await started.promise;
    await registry.touchSessionBrowserTab({ ...identity("docs"), now: 11_000 });
    closeGate.resolve();

    await expect(sweep).resolves.toBe(0);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-RACE",
      lastUsedAt: 11_000,
    });
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
  });

  it("holds only the selected tab through fresh cleanup read and close dispatch", async () => {
    const registry = await freshRegistry("guarded-close-admission");
    const selected = { sessionKey: "agent:main:main", targetId: "selected", profile: "remote" };
    const other = { ...selected, targetId: "other" };
    for (const tab of [selected, other]) {
      await registry.trackSessionBrowserTab({
        ...tab,
        ownership: ownership(tab.targetId),
        now: 1_000,
      });
    }
    const key = browserSessionTabStorageKey({
      ...ownership("selected"),
      sessionKey: selected.sessionKey,
    });
    const readCompleted = createDeferred<void>();
    const releaseRead = createDeferred<void>();
    const dispatched = createDeferred<void>();
    const finishClose = createDeferred<void>();
    const runtime = getBrowserStateRuntime();
    const bind = runtime.sessionTabs.withCurrent;
    if (!bind) {
      throw new Error("Expected the real worker comparison store");
    }
    let holdRead = false;
    const observer = vi
      .spyOn(runtime.sessionTabs, "withCurrent")
      .mockImplementation((authority) => {
        const store = bind(authority);
        return {
          ...store,
          lookup: async (requestedKey) => {
            const value = await store.lookup(requestedKey);
            if (holdRead && requestedKey === key) {
              holdRead = false;
              readCompleted.resolve();
              await releaseRead.promise;
            }
            return value;
          },
        };
      });
    const cleanup = registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: [selected.sessionKey],
      closeDurableTab: async (tab, options) => {
        if (tab.nativeTargetId !== "selected") {
          return { status: "unavailable", reason: "target-lookup-failed" };
        }
        holdRead = true;
        return await options.closeIfCurrent(async () => {
          dispatched.resolve();
          await finishClose.promise;
          return { status: "closed" };
        });
      },
    });
    let touched = false;
    let touch: Promise<void> | undefined;
    try {
      await readCompleted.promise;
      touch = registry.touchSessionBrowserTab({ ...selected, now: 2_000 }).then(() => {
        touched = true;
      });
      await registry.touchSessionBrowserTab({ ...other, now: 3_000 });
      expect(touched).toBe(false);
      releaseRead.resolve();
      await dispatched.promise;
      // The network response is still held; activity must now be able to settle.
      await touch;
      expect(touched).toBe(true);
      finishClose.resolve();
      await expect(cleanup).resolves.toBe(1);
    } finally {
      releaseRead.resolve();
      finishClose.resolve();
      await Promise.allSettled([cleanup, ...(touch ? [touch] : [])]);
      observer.mockRestore();
    }
  });

  it("does not delete a replacement row after an obsolete close completes", async () => {
    const registry = await freshRegistry("replacement-race");
    await registry.trackSessionBrowserTab(owned("opaque", "NATIVE-REPLACED", { now: 1_000 }));
    const closeDurableTab = vi.fn(
      async (_tab: DurableTab, options: CloseOptions) =>
        await options.closeIfCurrent(async () => {
          await registry.trackSessionBrowserTab(owned("opaque", "NATIVE-REPLACED", { now: 2_000 }));
          return { status: "closed" };
        }),
    );

    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-REPLACED",
      lastUsedAt: 2_000,
    });
    expect(openStore().entries()[0]?.value).not.toHaveProperty("cleanupAttemptToken");
  });

  it("deletes invalid or wrongly keyed rows without closing a target", async () => {
    const validRecord = record("NATIVE-WRONG-KEY");
    openStore().register("wrong-storage-key", validRecord);
    openStore().register("invalid-record", { version: 999, sessionKey: "agent:main:main" });
    openStore().register("partial-cleanup", {
      ...validRecord,
      nativeTargetId: "NATIVE-PARTIAL",
      cleanupRequestedAt: 2_000,
    });
    openStore().register("noncanonical-aliases", {
      ...validRecord,
      nativeTargetId: "NATIVE-ALIASES",
      profileAliases: ["zeta", "alpha"],
    });
    const warnings: string[] = [];
    const registry = await freshRegistry("invalid");
    const closeDurableTab = vi.fn(async () => ({ status: "closed" as const }));

    await registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:other"],
      closeDurableTab,
      onWarn: (message) => warnings.push(message),
    });
    expect(openStore().entries()).toEqual([]);
    expect(closeDurableTab).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(4);
  });

  it("defers a cold native sweep after observed activity without adopting the row", async () => {
    const coldRecord = record("NATIVE-COLD", { sessionKey: "agent:main:cold" });
    openStore().register(browserSessionTabStorageKey(coldRecord), coldRecord);
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-alias");

    await restarted.touchSessionBrowserTab({
      sessionKey: coldRecord.sessionKey,
      targetId: "docs-cold",
      profile: coldRecord.profile,
      now: 9_000,
    });
    await restarted.untrackSessionBrowserTab({
      sessionKey: coldRecord.sessionKey,
      targetId: "docs-cold",
      profile: coldRecord.profile,
    });
    expect(openStore().lookup(browserSessionTabStorageKey(coldRecord))).toMatchObject({
      lastUsedAt: 1_000,
    });

    await restarted.touchSessionBrowserTab({
      sessionKey: coldRecord.sessionKey,
      targetId: coldRecord.nativeTargetId,
      profile: coldRecord.profile,
      now: 10_000,
    });
    expect(openStore().lookup(browserSessionTabStorageKey(coldRecord))).toMatchObject({
      lastUsedAt: 1_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({ now: 12_000, idleMs: 5_000, closeDurableTab }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();

    await expect(
      restarted.sweepTrackedBrowserTabs({ now: 20_000, idleMs: 5_000, closeDurableTab }),
    ).resolves.toBe(1);
    expect(openStore().lookup(browserSessionTabStorageKey(coldRecord))).toBeUndefined();
  });

  it("defers a pending cold sweep when activity shares its timestamp", async () => {
    const first = await freshRegistry("cold-pending-first");
    await first.trackSessionBrowserTab({
      ...identity("NATIVE-COLD-PENDING", "agent:main:cold-pending"),
      ownership: ownership("NATIVE-COLD-PENDING"),
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-pending-restarted");
    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        closeDurableTab: async () => ({ status: "unavailable", reason: "target-lookup-failed" }),
      }),
    ).resolves.toBe(0);

    await restarted.touchSessionBrowserTab({
      ...identity("NATIVE-COLD-PENDING", "agent:main:cold-pending"),
      now: 10_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeDurableTab }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
  });

  it("defers cold opaque handles from sweeps but still performs lifecycle cleanup", async () => {
    const first = await freshRegistry("opaque-first");
    await first.trackSessionBrowserTab({
      ...identity("mcp-session-handle", "agent:main:opaque"),
      ownership: ownership("NATIVE-OPAQUE"),
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("opaque-restarted");
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);

    await expect(
      restarted.sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeDurableTab }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();

    await expect(
      restarted.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:opaque"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(closeDurableTab).toHaveBeenCalledOnce();
  });
});
