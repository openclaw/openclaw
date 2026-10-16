import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  disposeRegisteredAgentHarnesses,
  getRegisteredAgentHarness,
  listRegisteredAgentHarnesses,
  registerAgentHarness,
  resolveAgentHarnessOwnerPluginId,
  resolveCodexAgentHarnessNativeCompaction,
  resetRegisteredAgentHarnessSessions,
} from "./registry.js";
import { selectAgentHarness } from "./selection.js";
import type { AgentHarness } from "./types.js";

const resolveProviderRefOwnership = vi.hoisted(() => vi.fn(() => ({ status: "unowned" as const })));
const warn = vi.hoisted(() => vi.fn());

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => {
    const logger = {
      warn,
      trace: vi.fn(),
      debug: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      raw: vi.fn(),
      isEnabled: () => false,
      child: () => logger,
    };
    return logger;
  },
}));

// Registry tests exercise selection handoff; provider owner/route tests own the real artifacts,
// which would cold-load bundled plugin surfaces for this synthetic provider config.
vi.mock("../../plugins/providers.js", () => ({
  resolveProviderRefOwnership,
}));
vi.mock("../../plugins/provider-model-routes.js", () => ({
  resolveProviderModelCatalogId: () => null,
  resolveProviderModelPolicySurface: () => null,
  resolveProviderModelRoutes: () => null,
}));

beforeEach(() => {
  clearAgentHarnesses();
  warn.mockClear();
  resolveProviderRefOwnership.mockClear();
});

afterEach(() => {
  clearAgentHarnesses();
  vi.unstubAllEnvs();
});

function makeHarness(
  id: string,
  options: {
    priority?: number;
    providers?: readonly string[];
  } = {},
): AgentHarness {
  // Test harnesses keep support decisions provider-scoped so selection tests
  // can distinguish registration from runtime-policy preference.
  const providers = options.providers?.map((provider) => provider.trim().toLowerCase());
  return {
    id,
    label: id,
    supports: (ctx) =>
      !providers || providers.includes(ctx.provider.trim().toLowerCase())
        ? { supported: true, priority: options.priority ?? 10 }
        : { supported: false },
    async runAttempt() {
      throw new Error("not used");
    },
  };
}

function providerRuntimeConfig(provider: string, runtime: string): OpenClawConfig {
  return {
    models: {
      providers: {
        [provider]: {
          baseUrl: "https://api.openclaw.test/v1",
          agentRuntime: { id: runtime },
          models: [],
        },
      },
    },
  } as OpenClawConfig;
}

describe("agent harness registry", () => {
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
    const reset = resetRegisteredAgentHarnessSessions({ reason: "reset" }).catch(
      (error: unknown) => {
        events.push("reset rejected");
        return error;
      },
    );
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
    for (const id of ids) {
      registerAgentHarness({ ...makeHarness(id), reset: failingReset });
    }
    registerAgentHarness({ ...makeHarness("healthy-reset"), reset: healthyReset });
    await Promise.all(
      Array.from({ length: 110 }, () => resetRegisteredAgentHarnessSessions({ reason: "reset" })),
    );
    clearAgentHarnesses();
    for (const id of ids) {
      registerAgentHarness({ ...makeHarness(id), reset: failingReset });
    }
    await resetRegisteredAgentHarnessSessions({ reason: "reset" });
    expect(failingReset).toHaveBeenCalledTimes(222);
    expect(healthyReset).toHaveBeenCalledTimes(110);
    expect(warn).toHaveBeenCalledTimes(2);
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
  ] as const)(
    "rejects registration of %s by %s before mutation",
    (id, ownerPluginId, compact, message) => {
      expect(() =>
        registerAgentHarness(makeHarness(id), {
          ownerPluginId,
          ...(compact ? { nativeCompaction: async () => ({ ok: true, compacted: true }) } : {}),
        }),
      ).toThrow(message);
      expect(listRegisteredAgentHarnesses()).toEqual([]);
    },
  );

  it.each(["active", "request"] as const)(
    "rejects retired %s harnesses without falling through to another registry",
    async (context) => {
      const snapshot = captureActivePluginRegistrySnapshot();
      const active = createEmptyPluginRegistry();
      const selected = context === "active" ? active : createEmptyPluginRegistry();
      const dispose = vi.fn(async () => {});
      const reset = vi.fn(async () => {});
      const nativeCompaction = vi.fn(async () => ({ ok: true, compacted: true }));
      const inContext = <T>(run: () => T): T =>
        context === "request" ? withPluginRuntimeRegistryScope(selected, run) : run();
      try {
        setActivePluginRegistry(active);
        registerAgentHarness(makeHarness("codex"), { ownerPluginId: "codex" });
        withPluginRegistrationContext(selected, "codex", () =>
          registerAgentHarness({ ...makeHarness("codex"), dispose, reset }, { nativeCompaction }),
        );
        const registered = inContext(() => getRegisteredAgentHarness("codex"))!;
        expect(registered).toBeDefined();
        inContext(() => {
          expect([getRegisteredAgentHarness("codex"), listRegisteredAgentHarnesses()]).toEqual([
            registered,
            [registered],
          ]);
          expect(resolveAgentHarnessOwnerPluginId(registered.harness)).toBe("codex");
          expect(resolveCodexAgentHarnessNativeCompaction(registered.harness)).toBe(
            nativeCompaction,
          );
          expect(() => resolveCodexAgentHarnessNativeCompaction(makeHarness("codex"))).toThrow(
            "Agent harness codex changed during native compaction resolution",
          );
        });
        await inContext(() => resetRegisteredAgentHarnessSessions({ reason: "reset" }));
        await inContext(disposeRegisteredAgentHarnesses);
        expect(reset).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();

        markPluginRegistryRetired(selected);
        inContext(() => {
          expect.soft(getRegisteredAgentHarness("codex")).toBeUndefined();
          expect.soft(listRegisteredAgentHarnesses()).toEqual([]);
          expect
            .soft(() => resolveAgentHarnessOwnerPluginId(registered.harness))
            .toThrow("changed during owner resolution");
          expect
            .soft(() => resolveCodexAgentHarnessNativeCompaction(registered.harness))
            .toThrow("changed during native compaction resolution");
          expect
            .soft(() =>
              selectAgentHarness({
                provider: "synthetic",
                agentHarnessId: "codex",
              }),
            )
            .toThrow('Requested agent harness "codex" is not registered');
        });
        await inContext(() => resetRegisteredAgentHarnessSessions({ reason: "reset" }));
        await inContext(disposeRegisteredAgentHarnesses);
        expect.soft(reset).toHaveBeenCalledOnce();
        expect.soft(dispose).toHaveBeenCalledOnce();
        if (selected !== active) {
          expect(getRegisteredAgentHarness("codex")?.harness).not.toBe(registered.harness);
          expect(getRegisteredAgentHarness("codex")).toBeDefined();
        }
      } finally {
        restoreActivePluginRegistrySnapshot(snapshot);
      }
    },
  );

  it("uses builder ownership and preserves a harness registered by another plugin", () => {
    const building = createEmptyPluginRegistry();
    const original = makeHarness("shared");
    const registration: (typeof building.agentHarnesses)[number] = {
      pluginId: "first-plugin",
      source: "runtime",
      harness: original,
    };
    building.agentHarnesses.push(registration);

    expect(() =>
      withPluginRegistrationContext(building, "failing-plugin", () => {
        registerAgentHarness(makeHarness("shared"));
      }),
    ).toThrow("agent harness shared already registered by first-plugin");
    expect(building.agentHarnesses).toEqual([
      { pluginId: "first-plugin", source: "runtime", harness: original },
    ]);

    withPluginRegistrationContext(building, "builder-plugin", () => {
      registerAgentHarness(makeHarness("owned"));
    });
    expect(building.agentHarnesses[1]?.pluginId).toBe("builder-plugin");
  });

  it("keeps model-specific harnesses behind plugin registration in auto mode", () => {
    vi.stubEnv("OPENCLAW_AGENT_RUNTIME", "auto");

    expect(selectAgentHarness({ provider: "plugin-models", modelId: "custom-1" }).id).toBe(
      "openclaw",
    );

    registerAgentHarness(makeHarness("custom", { providers: ["plugin-models"] }), {
      ownerPluginId: "plugin-a",
    });

    expect(selectAgentHarness({ provider: "plugin-models", modelId: "custom-1" }).id).toBe(
      "custom",
    );
  });

  it.each([
    ["codex", "gpt-5.4", "openclaw", "plugin-harness", { priority: 200 }],
    ["anthropic", "sonnet-4.6", "custom", "custom", { providers: ["anthropic"] }],
  ] as const)("honors %s provider policy for %s", (provider, modelId, runtime, id, options) => {
    registerAgentHarness(makeHarness(id, options), { ownerPluginId: "plugin-a" });
    const config = providerRuntimeConfig(provider, runtime);
    expect(selectAgentHarness({ provider, modelId, config }).id).toBe(runtime);
    if (provider === "anthropic") {
      expect(resolveProviderRefOwnership).toHaveBeenCalledWith({ provider, config });
    }
  });
});
