import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { markPluginRegistryRetired } from "../../plugins/registry-lifecycle.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
  withPluginRegistrationContext,
} from "../../plugins/runtime.js";
import { withPluginRuntimeRegistryScope } from "../../plugins/runtime/gateway-request-scope.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { AgentHarnessSessionCleanupError } from "./errors.js";
import {
  clearAgentHarnesses,
  disposeRegisteredAgentHarnesses as disposeHarnesses,
  getRegisteredAgentHarness as getHarness,
  listRegisteredAgentHarnesses as listHarnesses,
  registerAgentHarness,
  resolveAgentHarnessOwnerPluginId as resolveOwner,
  resolveCodexAgentHarnessNativeCompaction as resolveCompaction,
  resetRegisteredAgentHarnessSessions as resetSessions,
} from "./registry.js";
import { selectAgentHarness } from "./selection.js";
import type { AgentHarness } from "./types.js";

const warn = vi.hoisted(() => vi.fn());

// mock-isolation: Capture warnings without initializing process-wide logging sinks.
vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      warn,
      ...Object.fromEntries(
        ["trace", "debug", "info", "error", "fatal", "raw"].map((level) => [level, vi.fn()]),
      ),
      isEnabled: () => false,
      child: () => logger,
    };
    return logger;
  },
}));

// Synthetic selection fixtures avoid cold-loading bundled provider artifacts.
// mock-isolation: selection tests supply ownership without initializing provider runtimes.
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership: () => ({ status: "unowned" }),
}));
vi.mock("../../plugins/provider-model-routes.js", () => ({
  resolveProviderModelCatalogId: () => null,
  resolveProviderModelPolicySurface: () => null,
  resolveProviderModelRoutes: () => null,
}));

beforeEach(() => {
  clearAgentHarnesses();
  warn.mockClear();
});

afterEach(() => {
  clearAgentHarnesses();
  vi.unstubAllEnvs();
});

function makeHarness(id: string): AgentHarness {
  return {
    id,
    label: id,
    supports: () => ({ supported: true, priority: 10 }),
    async runAttempt() {
      throw new Error("not used");
    },
  };
}

it("propagates required cleanup failure only after sibling reset hooks settle", async () => {
  const failure = new AgentHarnessSessionCleanupError("native session still running");
  const siblingStarted = createDeferredCore();
  const releaseSibling = createDeferredCore();
  const events: string[] = [];
  registerAgentHarness({
    ...makeHarness("required-cleanup"),
    reset: async () => {
      throw failure;
    },
  });
  registerAgentHarness({
    ...makeHarness("held-cleanup"),
    reset: async () => {
      siblingStarted.resolve();
      await releaseSibling.promise;
      events.push("sibling settled");
    },
  });
  vi.useFakeTimers();
  const reset = resetSessions({ reason: "reset" }).catch((error: unknown) => {
    events.push("reset rejected");
    return error;
  });
  try {
    await siblingStarted.promise;
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual([]);
    releaseSibling.resolve();
    expect(await reset).toBe(failure);
    expect(events).toEqual(["sibling settled", "reset rejected"]);
  } finally {
    releaseSibling.resolve();
    await reset;
    vi.useRealTimers();
  }
});

it("warns once per harness across reset failures and registry replacement while retrying", async () => {
  const failingReset = vi.fn(async () => {
    throw new Error("reset unavailable");
  });
  const healthyReset = vi.fn(async () => {});
  const ids = ["failing-reset-a", "failing-reset-b"];
  const registerFailing = () =>
    ids.forEach((id) => registerAgentHarness({ ...makeHarness(id), reset: failingReset }));
  registerFailing();
  registerAgentHarness({ ...makeHarness("healthy-reset"), reset: healthyReset });
  await Promise.all(Array.from({ length: 110 }, () => resetSessions({ reason: "reset" })));
  clearAgentHarnesses();
  registerFailing();
  await resetSessions({ reason: "reset" });
  expect([failingReset, healthyReset, warn].map((mock) => mock.mock.calls.length)).toEqual([
    222, 110, 2,
  ]);
  for (const id of ids) {
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("session reset hook failed"), {
      harnessId: id,
      error: expect.any(Error),
    });
  }
});

it.each([
  [
    "openclaw",
    "untrusted-plugin",
    false,
    'agent harness id "openclaw" is reserved for the built-in runtime',
  ],
  ["codex", "copilot", true, "native compaction requires the registry-owned Codex harness"],
] as const)("rejects %s from %s without mutation", (id, ownerPluginId, compact, message) => {
  expect(() =>
    registerAgentHarness(makeHarness(id), {
      ownerPluginId,
      ...(compact ? { nativeCompaction: async () => ({ ok: true, compacted: true }) } : {}),
    }),
  ).toThrow(message);
  expect(listHarnesses()).toEqual([]);
});

it.each(["active", "request"] as const)(
  "rejects retired %s harnesses without falling through to another registry",
  async (context) => {
    const snapshot = captureActivePluginRegistrySnapshot();
    const active = createEmptyPluginRegistry();
    const selected = context === "active" ? active : createEmptyPluginRegistry();
    const dispose = vi.fn(async () => {});
    const reset = vi.fn(async () => {});
    const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
    const select = () => selectAgentHarness({ provider: "synthetic", agentHarnessId: "codex" });
    const inContext = <T>(run: () => T): T =>
      context === "request" ? withPluginRuntimeRegistryScope(selected, run) : run();
    try {
      setActivePluginRegistry(active);
      registerAgentHarness(makeHarness("codex"), { ownerPluginId: "codex" });
      withPluginRegistrationContext(selected, "codex", () =>
        registerAgentHarness({ ...makeHarness("codex"), dispose, reset }, { nativeCompaction }),
      );
      const registered = inContext(() => getHarness("codex"))!;
      expect(registered).toBeDefined();
      const { harness } = registered;
      inContext(() => {
        expect([getHarness("codex"), listHarnesses()]).toEqual([registered, [registered]]);
        expect(resolveOwner(harness)).toBe("codex");
        expect(resolveCompaction(harness)).toBe(nativeCompaction);
        expect(() => resolveCompaction(makeHarness("codex"))).toThrow(
          "Agent harness codex changed during native compaction resolution",
        );
      });
      await inContext(() => resetSessions({ reason: "reset" }));
      await inContext(disposeHarnesses);
      expect([reset.mock.calls.length, dispose.mock.calls.length]).toEqual([1, 1]);

      markPluginRegistryRetired(selected);
      inContext(() => {
        expect.soft(getHarness("codex")).toBeUndefined();
        expect.soft(listHarnesses()).toEqual([]);
        expect.soft(() => resolveOwner(harness)).toThrow("changed during owner resolution");
        expect
          .soft(() => resolveCompaction(harness))
          .toThrow("changed during native compaction resolution");
        expect.soft(select).toThrow('Requested agent harness "codex" is not registered');
      });
      await inContext(() => resetSessions({ reason: "reset" }));
      await inContext(disposeHarnesses);
      expect.soft([reset.mock.calls.length, dispose.mock.calls.length]).toEqual([1, 1]);
      if (selected !== active) {
        expect(getHarness("codex")?.harness).not.toBe(harness);
        expect(getHarness("codex")).toBeDefined();
      }
    } finally {
      restoreActivePluginRegistrySnapshot(snapshot);
    }
  },
);

it("uses builder ownership and preserves a harness registered by another plugin", () => {
  const building = createEmptyPluginRegistry();
  const original = makeHarness("shared");
  building.agentHarnesses.push({ pluginId: "first-plugin", source: "runtime", harness: original });

  expect(() =>
    withPluginRegistrationContext(building, "failing-plugin", () =>
      registerAgentHarness(makeHarness("shared")),
    ),
  ).toThrow("agent harness shared already registered by first-plugin");
  expect(building.agentHarnesses).toEqual([
    { pluginId: "first-plugin", source: "runtime", harness: original },
  ]);

  withPluginRegistrationContext(building, "builder-plugin", () =>
    registerAgentHarness(makeHarness("owned")),
  );
  expect(building.agentHarnesses[1]?.pluginId).toBe("builder-plugin");
});
