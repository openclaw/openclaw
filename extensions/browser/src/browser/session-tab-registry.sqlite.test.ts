import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { SessionEntryCurrentPreparation } from "openclaw/plugin-sdk/plugin-state-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getBrowserStateRuntime } from "../browser-runtime-state.js";
import { createBrowserToolSessionTabs } from "../browser-tool-session-tabs.js";
import type { CloseTrackedCdpTargetResult } from "./cdp.helpers.js";
import { BROWSER_TAB_UNREACHABLE_RETIRE_MS } from "./constants.js";
import { browserSessionTabStorageKey } from "./session-tab-identity.js";
import {
  cdpMocks,
  clearProcessLocalTabState,
  setBrowserProfileConfig,
  installSessionTabRegistrySqliteHarness,
} from "./session-tab-registry.sqlite.test-harness.js";
import {
  type CloseTab,
  type DurableRecord,
  type RegistryModule,
  durableOwnership as ownership,
} from "./session-tab-registry.sqlite.test-helpers.js";

const { debugDiagnostics } = vi.hoisted(() => ({
  debugDiagnostics: vi.fn<(message: string) => void>(),
}));

vi.mock("openclaw/plugin-sdk/logging-core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/logging-core")>();
  function observe(
    logger: ReturnType<typeof actual.createSubsystemLogger>,
    path: string,
  ): typeof logger {
    return {
      ...logger,
      ...(path === "browser/service/session-tabs" ? { debug: debugDiagnostics } : {}),
      child: (name: string) => observe(logger.child(name), `${path}/${name}`),
    };
  }
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) =>
      observe(actual.createSubsystemLogger(subsystem), subsystem),
  };
});

type Cleanup = RegistryModule["closeTrackedBrowserTabsForSessions"];
type TrackOptions = Partial<Parameters<RegistryModule["trackSessionBrowserTab"]>[0]>;
const identity = (targetId: string, sessionKey = "agent:main:main", profile = "remote") => ({
  sessionKey,
  targetId,
  profile,
});
const volatile = (targetId: string, options: TrackOptions = {}) => ({
  ...identity(targetId),
  ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" } as const,
  ...options,
});
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
  const {
    openStore,
    installRuntime,
    freshRegistry: loadRegistry,
  } = installSessionTabRegistrySqliteHarness();
  async function freshRegistry(label: string) {
    const registry = await loadRegistry(label);
    return {
      ...registry,
      track: registry.trackSessionBrowserTab,
      own: (targetId: string, nativeId: string, options: TrackOptions = {}) =>
        registry.trackSessionBrowserTab({
          ...identity(targetId),
          ownership: ownership(nativeId),
          ...options,
        }),
      touch: (targetId: string, now: number, options: Partial<ReturnType<typeof identity>> = {}) =>
        registry.touchSessionBrowserTab({ ...identity(targetId), now, ...options }),
      untrack: (targetId: string, options: Partial<ReturnType<typeof identity>> = {}) =>
        registry.untrackSessionBrowserTab({ ...identity(targetId), ...options }),
      sweep: (
        now: number,
        options: Omit<Parameters<RegistryModule["sweepTrackedBrowserTabs"]>[0], "now"> = {},
      ) => registry.sweepTrackedBrowserTabs({ idleMs: 1, now, ...options }),
      filter: registry.filterTrackedSessionBrowserTabs,
    };
  }
  beforeEach(setBrowserProfileConfig);
  const rows = () =>
    openStore()
      .entries()
      .map((entry) => entry.value);
  const expectRows = (...expected: object[]) =>
    expect(rows()).toEqual(expected.map((row) => expect.objectContaining(row)));
  const expectUnclaimedRow = (expected: object) => {
    expectRows(expected);
    expect(rows()[0]).not.toHaveProperty("cleanupAttemptToken");
  };
  const close = (
    registry: RegistryModule,
    options: Omit<Parameters<Cleanup>[0], "sessionKeys"> & SessionEntryCurrentPreparation,
    sessionKeys = ["agent:main:main"],
  ) => registry.closeTrackedBrowserTabsForSessions({ sessionKeys, ...options });

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
      await close(registry, { closeTab }, ["global"]);
      expect(closed).toEqual([]);
      await close(registry, { closeTab }, ["agent:alpha:global"]);
      expect(closed).toEqual(["alpha-tab"]);
      await close(registry, { closeTab }, ["agent:beta:global"]);
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
    const closeTab = vi.fn<CloseTab>(async () => {});
    expect(
      await registry.filter({
        sessionKey: "agent:alpha:global",
        profile: "remote",
        tabs: [{ targetId: "legacy-tab" }],
      }),
    ).toEqual([]);
    await close(registry, { closeTab }, ["global", "agent:alpha:global"]);
    await registry.sweep(1000, { closeTab });
    expect(closeTab).not.toHaveBeenCalled();
    expect([openStore().lookup(key), openStore().lookup("unknown-legacy")]).toEqual([
      undefined,
      undefined,
    ]);
  });

  it("does not publish volatile ownership after its hydrated runtime is replaced", async () => {
    const registry = await freshRegistry("volatile-runtime-replacement");
    const tracking = registry.track(identity("stale-volatile"));
    const replacement = Promise.resolve().then(() => installRuntime());
    try {
      await expect(tracking).rejects.toThrow("Browser session tab store owner changed");
    } finally {
      await Promise.allSettled([tracking, replacement]);
    }
    const closeTab = vi.fn<CloseTab>(async () => {});
    expect(await close(registry, { closeTab })).toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("keeps browser-bridge aliases isolated from host-browser durable records", async () => {
    const registry = await freshRegistry("bridge-alias-isolation");
    await registry.own("shared-target", "NATIVE-HOST", { now: 1_000 });
    const bridge = {
      ...identity("shared-target"),
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9999" },
    } as const;
    await registry.track({
      ...bridge,
      ownership: ownership("NATIVE-BRIDGE"),
      now: 2_000,
    });
    await registry.touch("shared-target", 3_000, bridge);
    await registry.untrack("shared-target", bridge);
    expectRows({ nativeTargetId: "NATIVE-HOST", lastUsedAt: 1_000 });
  });

  it.each(["durable", "volatile"] as const)(
    "prefers an exact %s target over the other ownership kind's alias while untracking",
    async (exact) => {
      let registry = await freshRegistry(`exact-${exact}`);
      const durableExact = exact === "durable";
      await registry.own(durableExact ? "DURABLE-NATIVE" : "DURABLE-OPAQUE", "DURABLE-NATIVE", {
        now: 1_000,
        ...(durableExact ? {} : { aliases: ["VOLATILE-RAW"] }),
      });
      if (durableExact) {
        clearProcessLocalTabState();
        await installRuntime();
        registry = await freshRegistry("exact-durable-restarted");
      }
      await registry.track(
        volatile("VOLATILE-RAW", {
          now: 2_000,
          ...(durableExact ? { aliases: ["DURABLE-NATIVE"] } : {}),
        }),
      );
      await registry.untrack(durableExact ? "DURABLE-NATIVE" : "VOLATILE-RAW");
      expect(openStore().entries()).toHaveLength(durableExact ? 0 : 1);
      const closeTab = vi.fn<CloseTab>(async () => {});
      await expect(close(registry, { closeTab })).resolves.toBe(1);
      expect(closeTab).toHaveBeenCalledWith(
        durableExact
          ? { targetId: "VOLATILE-RAW", baseUrl: undefined, profile: "remote" }
          : expect.objectContaining({ nativeTargetId: "DURABLE-NATIVE" }),
      );
    },
  );

  it("keeps durable ownership when volatile exact profile aliases are ambiguous", async () => {
    const registry = await freshRegistry("cross-kind-exact-ambiguity");
    await registry.track({
      ...identity("SHARED-NATIVE", "agent:main:main", "requested-profile"),
      ownership: ownership("SHARED-NATIVE"),
      now: 1_000,
    });
    for (const profile of ["resolved-a", "resolved-b"]) {
      await registry.track(
        volatile("SHARED-NATIVE", {
          profile,
          profileAliases: ["requested-profile"],
          now: 2_000,
        }),
      );
    }

    await registry.untrack("SHARED-NATIVE", { profile: "requested-profile" });
    expect(openStore().entries()).toHaveLength(1);

    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(close(registry, { closeTab })).resolves.toBe(3);
    expect(closeTab).toHaveBeenCalledTimes(3);
    expect(closeTab).toHaveBeenCalledWith(
      expect.objectContaining({ nativeTargetId: "SHARED-NATIVE", profile: "requested-profile" }),
    );
  });

  it("fails closed when resolved-profile aliases collide", async () => {
    const registry = await freshRegistry("resolved-profile-collision");
    for (const [profile, nativeTargetId] of [
      ["resolved-a", "browser-a"],
      ["resolved-b", "browser-b"],
    ] as const) {
      await registry.track({
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

    await restarted.touch("NATIVE-SHARED", 9_000, { profile: "requested-profile" });
    expect(rows()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ browserInstanceFingerprint: "browser-a", lastUsedAt: 1_000 }),
        expect.objectContaining({ browserInstanceFingerprint: "browser-b", lastUsedAt: 1_000 }),
      ]),
    );

    await restarted.untrack("NATIVE-SHARED", { profile: "resolved-b" });
    await restarted.touch("NATIVE-SHARED", 10_000, { profile: "requested-profile" });
    expectRows({ browserInstanceFingerprint: "browser-a", lastUsedAt: 10_000 });
  });

  it("keeps identical native ids isolated across browser instances", async () => {
    const first = await freshRegistry("browser-instance-collision-first");
    for (const [suffix, now] of [
      ["a", 1_000],
      ["b", 2_000],
    ] as const) {
      await first.track({
        ...identity("NATIVE-SHARED", "agent:main:collision"),
        ownership: ownership("NATIVE-SHARED", `profile-${suffix}`, `browser-${suffix}`),
        now,
      });
    }
    expect(openStore().entries()).toHaveLength(2);

    clearProcessLocalTabState();
    const restarted = await freshRegistry("browser-instance-collision-restarted");
    await restarted.touch("NATIVE-SHARED", 10_000, { sessionKey: "agent:main:collision" });
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(restarted.sweep(10_000, { closeTab })).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
    expect(
      rows()
        .map((row) => (row as DurableRecord).lastUsedAt)
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
    await expect(registry.own("tab-5000", "NATIVE-5000", { now: 5_001 })).rejects.toThrow(
      /5000-row limit/,
    );

    const records = rows() as DurableRecord[];
    expect(records).toHaveLength(5_000);
    expect(records.some((row) => row.nativeTargetId === "NATIVE-0")).toBe(true);
    expect(records.some((row) => row.nativeTargetId === "NATIVE-4999")).toBe(true);
    expect(records.some((row) => row.nativeTargetId === "NATIVE-5000")).toBe(false);
  });

  it("keeps transient close failures and retires terminal outcomes", async () => {
    const registry = await freshRegistry("outcomes");
    for (const target of ["closed", "missing", "mismatch", "unavailable"]) {
      await registry.own(target, `NATIVE-${target}`, { sessionKey: `agent:main:${target}` });
    }
    const outcomeByTarget: Record<string, CloseTrackedCdpTargetResult> = {
      "NATIVE-closed": { status: "closed" },
      "NATIVE-missing": { status: "missing" },
      "NATIVE-mismatch": { status: "ownership-mismatch" },
      "NATIVE-unavailable": { status: "unavailable", reason: "target-lookup-failed" },
    };
    cdpMocks.closeTrackedCdpTarget.mockImplementation(
      async ({ nativeTargetId }) => outcomeByTarget[nativeTargetId]!,
    );

    await expect(
      close(registry, {}, ["agent:main:closed", "agent:main:missing", "agent:main:mismatch"]),
    ).resolves.toBe(1);
    await expect(close(registry, {}, ["agent:main:unavailable"])).resolves.toBe(0);
    expectRows({ nativeTargetId: "NATIVE-unavailable" });
  });

  it("bounds deferred warnings by reason and registration while retaining debug diagnostics", async () => {
    const registry = await freshRegistry("deferred-warning-bound");
    const tracked = 1_000;
    const track = (now: number) => registry.own("gone", "NATIVE-gone", { now });
    await track(tracked);
    const warnings: string[] = [];
    debugDiagnostics.mockClear();
    let reason: "browser-identity-lookup-failed" | "browser-identity-unavailable" =
      "browser-identity-lookup-failed";
    cdpMocks.closeTrackedCdpTarget.mockImplementation(async () => ({
      status: "unavailable",
      reason,
    }));
    const deferred = (value: string) => `deferred tracked browser tab NATIVE-gone: ${value}`;
    const sweepAt = (now: number) =>
      registry.sweep(now, { onWarn: (message) => warnings.push(message) });

    await sweepAt(tracked + 1);
    await sweepAt(tracked + 2);
    await sweepAt(tracked + 3);
    expect(warnings).toEqual([deferred("browser-identity-lookup-failed")]);
    expect(debugDiagnostics.mock.calls.map(([message]) => message)).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-lookup-failed"),
    ]);
    expect(openStore().entries()).toHaveLength(1);

    reason = "browser-identity-unavailable";
    await sweepAt(tracked + 4);
    expect(warnings).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-unavailable"),
    ]);
    cdpMocks.closeTrackedCdpTarget.mockResolvedValueOnce({ status: "closed" });
    await sweepAt(tracked + 5);
    expect(openStore().entries()).toEqual([]);
    await track(tracked + 6);
    await sweepAt(tracked + 7);
    expect(warnings).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-unavailable"),
      deferred("browser-identity-unavailable"),
    ]);
    await sweepAt(tracked + 6 + BROWSER_TAB_UNREACHABLE_RETIRE_MS);
    expect(warnings).toEqual([
      deferred("browser-identity-lookup-failed"),
      deferred("browser-identity-unavailable"),
      deferred("browser-identity-unavailable"),
      "retired unreachable tracked browser tab NATIVE-gone: browser-identity-unavailable",
    ]);
    expect(openStore().entries()).toEqual([]);
  });

  it("keeps an old unreachable row when activity revokes its retirement claim", async () => {
    const registry = await freshRegistry("unreachable-touch-race");
    const tracked = 1_000;
    const sweepNow = tracked + BROWSER_TAB_UNREACHABLE_RETIRE_MS;
    await registry.own("gone", "NATIVE-gone", { now: tracked });

    cdpMocks.closeTrackedCdpTarget.mockImplementation(async ({ closeIfCurrent }) => {
      await registry.touch("gone", sweepNow);
      const dispatch = vi.fn(async () => ({ status: "closed" as const }));
      await expect(closeIfCurrent?.(dispatch)).resolves.toEqual({ status: "cancelled" });
      expect(dispatch).not.toHaveBeenCalled();
      return { status: "unavailable", reason: "browser-identity-lookup-failed" };
    });
    await registry.sweep(sweepNow);

    expectUnclaimedRow({ lastUsedAt: sweepNow });
  });

  it("cancels an in-flight sweep when the tab becomes active before close", async () => {
    const registry = await freshRegistry("sweep-touch-race");
    await registry.own("opaque", "NATIVE-RACE", {
      aliases: ["opaque", "docs"],
      now: 1_000,
    });
    const started = createDeferred<void>();
    const closeGate = createDeferred<void>();
    cdpMocks.closeTrackedCdpTarget.mockImplementation(async ({ closeIfCurrent }) => {
      started.resolve();
      await closeGate.promise;
      if (!closeIfCurrent) {
        throw new Error("Expected current cleanup dispatch");
      }
      return await closeIfCurrent(async () => ({ status: "closed" }));
    });

    const sweep = registry.sweep(10_000);
    await started.promise;
    await registry.touch("docs", 11_000);
    closeGate.resolve();

    await expect(sweep).resolves.toBe(0);
    expectUnclaimedRow({ nativeTargetId: "NATIVE-RACE", lastUsedAt: 11_000 });
  });

  it("holds only the selected tab through fresh cleanup read and close dispatch", async () => {
    const registry = await freshRegistry("guarded-close-admission");
    const selected = identity("selected");
    const other = { ...selected, targetId: "other" };
    for (const tab of [selected, other]) {
      await registry.track({
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
    cdpMocks.closeTrackedCdpTarget.mockImplementation(
      async ({ nativeTargetId, closeIfCurrent }) => {
        if (nativeTargetId !== "selected") {
          return { status: "unavailable", reason: "target-lookup-failed" };
        }
        holdRead = true;
        if (!closeIfCurrent) {
          throw new Error("Expected current cleanup dispatch");
        }
        return await closeIfCurrent(async () => {
          dispatched.resolve();
          await finishClose.promise;
          return { status: "closed" };
        });
      },
    );
    const cleanup = registry.closeTrackedBrowserTabsForSessions({
      sessionKeys: [selected.sessionKey],
    });
    let touched = false;
    let touch: Promise<void> | undefined;
    try {
      await readCompleted.promise;
      touch = registry.touch(selected.targetId, 2_000, selected).then(() => {
        touched = true;
      });
      await registry.touch(other.targetId, 3_000, other);
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
    await registry.own("opaque", "NATIVE-REPLACED", { now: 1_000 });
    cdpMocks.closeTrackedCdpTarget.mockImplementation(async ({ closeIfCurrent }) => {
      if (!closeIfCurrent) {
        throw new Error("Expected current cleanup dispatch");
      }
      return await closeIfCurrent(async () => {
        await registry.own("opaque", "NATIVE-REPLACED", { now: 2_000 });
        return { status: "closed" };
      });
    });

    await expect(close(registry, {})).resolves.toBe(1);
    expectUnclaimedRow({ nativeTargetId: "NATIVE-REPLACED", lastUsedAt: 2_000 });
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
    const closeTab = vi.fn<CloseTab>(async () => {});

    await close(registry, { closeTab, onWarn: (message) => warnings.push(message) }, [
      "agent:main:other",
    ]);
    expect(openStore().entries()).toEqual([]);
    expect(closeTab).not.toHaveBeenCalled();
    expect(warnings).toHaveLength(4);
  });

  it("defers a cold native sweep after observed activity without adopting the row", async () => {
    const coldRecord = record("NATIVE-COLD", { sessionKey: "agent:main:cold" });
    openStore().register(browserSessionTabStorageKey(coldRecord), coldRecord);
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-alias");

    const cold = identity("docs-cold", coldRecord.sessionKey, coldRecord.profile);
    const storedCold = () => openStore().lookup(browserSessionTabStorageKey(coldRecord));
    await restarted.touch(cold.targetId, 9_000, cold);
    await restarted.untrack(cold.targetId, cold);
    expect(storedCold()).toMatchObject({ lastUsedAt: 1_000 });
    await restarted.touch(coldRecord.nativeTargetId, 10_000, {
      sessionKey: cold.sessionKey,
      profile: cold.profile,
    });
    expect(storedCold()).toMatchObject({ lastUsedAt: 1_000 });
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(restarted.sweep(12_000, { idleMs: 5_000, closeTab })).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();

    await expect(restarted.sweep(20_000, { idleMs: 5_000, closeTab })).resolves.toBe(1);
    expect(storedCold()).toBeUndefined();
  });

  it("defers a pending cold sweep when activity shares its timestamp", async () => {
    const first = await freshRegistry("cold-pending-first");
    const cold = identity("NATIVE-COLD-PENDING", "agent:main:cold-pending");
    await first.track({
      ...cold,
      ownership: ownership(cold.targetId),
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("cold-pending-restarted");
    cdpMocks.closeTrackedCdpTarget.mockResolvedValue({
      status: "unavailable",
      reason: "target-lookup-failed",
    });
    await expect(restarted.sweep(10_000)).resolves.toBe(0);

    await restarted.touch(cold.targetId, 10_000, cold);
    const closeTab = vi.fn<CloseTab>(async () => {});
    await expect(restarted.sweep(10_000, { closeTab })).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("defers cold opaque handles from sweeps but still performs lifecycle cleanup", async () => {
    const first = await freshRegistry("opaque-first");
    await first.own("mcp-session-handle", "NATIVE-OPAQUE", {
      sessionKey: "agent:main:opaque",
      now: 1_000,
    });
    clearProcessLocalTabState();
    const restarted = await freshRegistry("opaque-restarted");
    const closeTab = vi.fn<CloseTab>(async () => {});

    await expect(restarted.sweep(10_000, { closeTab })).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();

    await expect(close(restarted, { closeTab }, ["agent:main:opaque"])).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
  });
});
