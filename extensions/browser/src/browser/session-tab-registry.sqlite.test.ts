// Browser tests cover durable session tab cleanup through the real plugin-state store.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserToolSessionTabs } from "../browser-tool-session-tabs.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import {
  clearProcessLocalTabState,
  installSessionTabRegistrySqliteHarness,
} from "./session-tab-registry.sqlite.test-harness.js";
import {
  type CloseTab,
  type CloseOptions,
  type DurableRecord,
  type DurableTab,
  durableOwnership as ownership,
} from "./session-tab-registry.sqlite.test-helpers.js";
import { browserSessionTabStorageKey } from "./session-tab-store.js";

describe("durable session tab registry", () => {
  const { openStore, installRuntime, freshRegistry } = installSessionTabRegistrySqliteHarness();

  it("persists tool tab activity without host data SQL", async () => {
    const registry = await freshRegistry("worker-tool-activity");
    const tabs = createBrowserToolSessionTabs({
      sessionKey: "agent:main:main",
      requestedProfile: "remote",
      defaultProfile: "remote",
      registry,
    });
    const observation = observeHostDataSql();
    try {
      await tabs.trackOpened(
        {
          targetId: "NATIVE-WORKER",
          resolvedProfile: "remote",
          ownership: ownership("NATIVE-WORKER"),
        },
        async () => {},
      );
      await tabs.touch("NATIVE-WORKER");
    } finally {
      observation.restore();
    }
    expect(openStore().entries()).toEqual([
      expect.objectContaining({
        value: expect.objectContaining({ nativeTargetId: "NATIVE-WORKER" }),
      }),
    ]);
    expect(observation.queries).toEqual([]);
  });

  it("keeps browser-bridge tabs volatile and closable by a duplicate bundle", async () => {
    const first = await freshRegistry("bridge-first");
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "bridge-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
      profile: "remote",
      ownership: ownership("REMOTE-NATIVE"),
    });
    expect(openStore().entries()).toEqual([]);

    const duplicate = await freshRegistry("bridge-duplicate");
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      duplicate.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "bridge-tab",
      baseUrl: "http://127.0.0.1:9999",
      profile: "remote",
    });
  });

  it("does not publish volatile ownership after its hydrated runtime is replaced", async () => {
    const registry = await freshRegistry("volatile-runtime-replacement");
    const tracking = registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "stale-volatile",
      profile: "remote",
    });
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
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-target",
      profile: "remote",
      ownership: ownership("NATIVE-HOST"),
      now: 1_000,
    });
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
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "DURABLE-NATIVE",
      profile: "remote",
      ownership: ownership("DURABLE-NATIVE"),
      now: 1_000,
    });

    clearProcessLocalTabState();
    await installRuntime();
    const restarted = await freshRegistry("durable-exact-over-volatile-alias-restarted");
    await restarted.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "VOLATILE-RAW",
      profile: "remote",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      aliases: ["DURABLE-NATIVE"],
      now: 2_000,
    });

    await restarted.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "DURABLE-NATIVE",
      profile: "remote",
    });
    expect(openStore().entries()).toEqual([]);

    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      restarted.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
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
      sessionKey: "agent:main:main",
      targetId: "DURABLE-OPAQUE",
      profile: "remote",
      ownership: ownership("DURABLE-NATIVE"),
      aliases: ["VOLATILE-RAW"],
      now: 1_000,
    });
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "VOLATILE-RAW",
      profile: "remote",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      now: 2_000,
    });

    await registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "VOLATILE-RAW",
      profile: "remote",
    });
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
      sessionKey: "agent:main:main",
      targetId: "SHARED-NATIVE",
      profile: "requested-profile",
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

    await registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "SHARED-NATIVE",
      profile: "requested-profile",
    });
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

  it("keys durable records by ownership and resolves same-process aliases", async () => {
    const registry = await freshRegistry("aliases");
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-1",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      aliases: ["opaque-1", "t1", "docs"],
      now: 1_000,
    });
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-2",
      profile: "remote",
      ownership: ownership("NATIVE-A"),
      aliases: ["opaque-2", "t2"],
      now: 2_000,
    });

    expect(openStore().entries()).toHaveLength(1);
    expect(openStore().entries()[0]?.value).toMatchObject({
      nativeTargetId: "NATIVE-A",
      trackedAt: 1_000,
      lastUsedAt: 2_000,
    });
    await registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "t2",
      profile: "remote",
      now: 3_000,
    });
    expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 3_000 });
    await registry.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-2",
      profile: "remote",
    });
    expect(openStore().entries()).toEqual([]);
  });

  it("resolves durable activity through the originally requested profile", async () => {
    const registry = await freshRegistry("resolved-profile-alias");
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque-resolved",
      profile: "resolved-profile",
      profileAliases: ["requested-profile"],
      ownership: ownership("NATIVE-RESOLVED"),
      aliases: ["opaque-resolved", "docs"],
      now: 1_000,
    });
    expect(openStore().entries()[0]?.value).toMatchObject({
      profileAliases: ["requested-profile"],
    });

    clearProcessLocalTabState();
    await installRuntime();
    const restarted = await freshRegistry("resolved-profile-alias-restarted");

    await restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-RESOLVED",
      profile: "requested-profile",
      now: 9_000,
    });
    expect(openStore().entries()[0]?.value).toMatchObject({ lastUsedAt: 9_000 });

    await restarted.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-RESOLVED",
      profile: "requested-profile",
    });
    expect(openStore().entries()).toEqual([]);
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
      sessionKey: "agent:main:main",
      targetId: "NATIVE-SHARED",
      profile: "requested-profile",
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

    await restarted.untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-SHARED",
      profile: "resolved-b",
    });
    await restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NATIVE-SHARED",
      profile: "requested-profile",
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
      sessionKey: "agent:main:collision",
      targetId: "NATIVE-SHARED",
      profile: "remote",
      ownership: ownership("NATIVE-SHARED", "profile-a", "browser-a"),
      now: 1_000,
    });
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:collision",
      targetId: "NATIVE-SHARED",
      profile: "remote",
      ownership: ownership("NATIVE-SHARED", "profile-b", "browser-b"),
      now: 2_000,
    });
    expect(openStore().entries()).toHaveLength(2);

    clearProcessLocalTabState();
    const restarted = await freshRegistry("browser-instance-collision-restarted");
    await restarted.touchSessionBrowserTab({
      sessionKey: "agent:main:collision",
      targetId: "NATIVE-SHARED",
      profile: "remote",
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
      const record = {
        version: 1,
        sessionKey: "agent:main:main",
        nativeTargetId: `NATIVE-${index}`,
        profile: "remote",
        profileFingerprint: "test-profile-fingerprint",
        browserInstanceFingerprint: "test-browser-instance-fingerprint",
        interactionTargetKind: "opaque",
        trackedAt: index + 1,
        lastUsedAt: index + 1,
      } satisfies DurableRecord;
      store.register(browserSessionTabStorageKey(record), record);
    }
    await expect(
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "tab-5000",
        profile: "remote",
        ownership: ownership("NATIVE-5000"),
        now: 5_001,
      }),
    ).rejects.toThrow(/5000-row limit/);

    const records = openStore()
      .entries()
      .map((entry) => entry.value as DurableRecord);
    expect(records).toHaveLength(5_000);
    expect(records.some((record) => record.nativeTargetId === "NATIVE-0")).toBe(true);
    expect(records.some((record) => record.nativeTargetId === "NATIVE-4999")).toBe(true);
    expect(records.some((record) => record.nativeTargetId === "NATIVE-5000")).toBe(false);
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

  it("retires a durable tab whose browser stays unreachable past the retire age", async () => {
    const registry = await freshRegistry("unreachable");
    const tracked = 1_000;
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "gone",
      profile: "remote",
      ownership: ownership("NATIVE-gone"),
      now: tracked,
    });
    const closeDurableTab = async (): Promise<CloseTrackedCdpTargetResult> => ({
      status: "unavailable",
      reason: "browser-identity-lookup-failed",
    });
    const sweepAt = (now: number) =>
      registry.sweepTrackedBrowserTabs({ now, idleMs: 1, closeDurableTab });

    // Still inside the retire window: a transient outage must not drop the row.
    await sweepAt(tracked + BROWSER_TAB_UNREACHABLE_RETIRE_MS - 1);
    expect(openStore().entries()).toHaveLength(1);

    await sweepAt(tracked + BROWSER_TAB_UNREACHABLE_RETIRE_MS);
    expect(openStore().entries()).toEqual([]);
  });

  it("warns once per deferred durable tab and keeps repeated deferrals at debug level", async () => {
    const registry = await freshRegistry("deferred-warning-bound");
    const tracked = 1_000;
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "gone",
      profile: "remote",
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
        sessionKey: "agent:main:main",
        targetId: "gone",
        profile: "remote",
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
      sessionKey: "agent:main:main",
      targetId: "gone",
      profile: "remote",
      ownership: ownership("NATIVE-gone"),
      now: tracked,
    });

    await registry.sweepTrackedBrowserTabs({
      now: sweepNow,
      idleMs: 1,
      closeDurableTab: async (_tab, options) => {
        await registry.touchSessionBrowserTab({
          sessionKey: "agent:main:main",
          targetId: "gone",
          profile: "remote",
          now: sweepNow,
        });
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

  it("keeps a touched durable tab out of an idle sweep but lifecycle cleanup still closes it", async () => {
    const registry = await freshRegistry("touch");
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-TOUCH"),
      aliases: ["opaque", "docs"],
      now: 1_000,
    });
    await registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "remote",
      now: 9_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);

    await expect(
      registry.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 5_000,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
    await expect(
      registry.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeDurableTab,
      }),
    ).resolves.toBe(1);
  });

  it("cancels an in-flight sweep when the tab becomes active before close", async () => {
    const registry = await freshRegistry("sweep-touch-race");
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-RACE"),
      aliases: ["opaque", "docs"],
      now: 1_000,
    });
    let markStarted: (() => void) | undefined;
    let releaseClose: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeDurableTab = vi.fn(async (_tab: DurableTab, options: CloseOptions) => {
      markStarted?.();
      await closeGate;
      return await options.closeIfCurrent(async () => ({ status: "closed" }));
    });

    const sweep = registry.sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      closeDurableTab,
    });
    await started;
    await registry.touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "remote",
      now: 11_000,
    });
    releaseClose?.();

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
    await registry.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "opaque",
      profile: "remote",
      ownership: ownership("NATIVE-REPLACED"),
      now: 1_000,
    });
    const closeDurableTab = vi.fn(
      async (_tab: DurableTab, options: CloseOptions) =>
        await options.closeIfCurrent(async () => {
          await registry.trackSessionBrowserTab({
            sessionKey: "agent:main:main",
            targetId: "opaque",
            profile: "remote",
            ownership: ownership("NATIVE-REPLACED"),
            now: 2_000,
          });
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

  it("throws when durable registration cannot write SQLite", async () => {
    await installRuntime((options) => {
      const store = createPluginStateKeyedStoreForTests("browser", options);
      return {
        ...store,
        withCurrent: (authority) => ({
          ...store.withCurrent(authority),
          compareAndApply: async () => {
            throw new Error("sqlite unavailable");
          },
        }),
      };
    });
    const registry = await freshRegistry("write-failure");

    await expect(
      registry.trackSessionBrowserTab({
        sessionKey: "agent:main:main",
        targetId: "tab-a",
        profile: "remote",
        ownership: ownership("NATIVE-A"),
      }),
    ).rejects.toThrow("sqlite unavailable");
  });

  it("deletes invalid or wrongly keyed rows without closing a target", async () => {
    const validRecord = {
      version: 1,
      sessionKey: "agent:main:main",
      nativeTargetId: "NATIVE-WRONG-KEY",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      interactionTargetKind: "native",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    } satisfies DurableRecord;
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

  it("keeps non-durable tabs out of SQLite but shared across duplicate bundles", async () => {
    const first = await freshRegistry("volatile-first");
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "volatile",
      profile: "remote",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
    });
    expect(openStore().entries()).toEqual([]);

    const duplicate = await freshRegistry("volatile-duplicate");
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(
      duplicate.closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("defers a cold native sweep after observed activity without adopting the row", async () => {
    const record = {
      version: 1,
      sessionKey: "agent:main:cold",
      nativeTargetId: "NATIVE-COLD",
      profile: "remote",
      profileFingerprint: "test-profile-fingerprint",
      browserInstanceFingerprint: "test-browser-instance-fingerprint",
      interactionTargetKind: "native",
      trackedAt: 1_000,
      lastUsedAt: 1_000,
    } satisfies DurableRecord;
    openStore().register(browserSessionTabStorageKey(record), record);
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-alias");

    await restarted.touchSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: "docs-cold",
      profile: record.profile,
      now: 9_000,
    });
    await restarted.untrackSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: "docs-cold",
      profile: record.profile,
    });
    expect(openStore().lookup(browserSessionTabStorageKey(record))).toMatchObject({
      lastUsedAt: 1_000,
    });

    await restarted.touchSessionBrowserTab({
      sessionKey: record.sessionKey,
      targetId: record.nativeTargetId,
      profile: record.profile,
      now: 10_000,
    });
    expect(openStore().lookup(browserSessionTabStorageKey(record))).toMatchObject({
      lastUsedAt: 1_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 12_000,
        idleMs: 5_000,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();

    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 20_000,
        idleMs: 5_000,
        closeDurableTab,
      }),
    ).resolves.toBe(1);
    expect(openStore().lookup(browserSessionTabStorageKey(record))).toBeUndefined();
  });

  it("defers a pending cold sweep when activity shares its timestamp", async () => {
    const first = await freshRegistry("cold-pending-first");
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:cold-pending",
      targetId: "NATIVE-COLD-PENDING",
      profile: "remote",
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
      sessionKey: "agent:main:cold-pending",
      targetId: "NATIVE-COLD-PENDING",
      profile: "remote",
      now: 10_000,
    });
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);
    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        closeDurableTab,
      }),
    ).resolves.toBe(0);
    expect(closeDurableTab).not.toHaveBeenCalled();
  });

  it("defers cold opaque handles from sweeps but still performs lifecycle cleanup", async () => {
    const first = await freshRegistry("opaque-first");
    await first.trackSessionBrowserTab({
      sessionKey: "agent:main:opaque",
      targetId: "mcp-session-handle",
      profile: "remote",
      ownership: ownership("NATIVE-OPAQUE"),
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("opaque-restarted");
    const closeDurableTab = vi.fn(async () => ({ status: "closed" }) as const);

    await expect(
      restarted.sweepTrackedBrowserTabs({
        now: 10_000,
        idleMs: 1,
        closeDurableTab,
      }),
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
