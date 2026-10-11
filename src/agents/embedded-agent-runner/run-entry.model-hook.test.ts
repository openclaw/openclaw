import { afterEach, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { FailoverError } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { makeResult } from "./run-entry.test-support.js";

vi.mock("../auth-profiles/source-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/source-check.js")>()),
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetFallbackSkipCacheForTest();
});

it.each([
  { name: "empty", fallbacksOverride: [], expected: ["local"], succeeds: false, locked: false },
  {
    name: "local-only",
    fallbacksOverride: ["fixture/local-backup"],
    expected: ["local", "local-backup"],
    succeeds: true,
    locked: false,
  },
  {
    name: "omitted",
    fallbacksOverride: undefined,
    expected: ["primary", "configured-backup"],
    succeeds: true,
    locked: false,
  },
  {
    name: "locked",
    fallbacksOverride: ["fixture/local-backup"],
    expected: ["primary"],
    succeeds: false,
    locked: true,
  },
])("uses the $name hook fallback chain at the logical run boundary", async (scenario) => {
  await withOpenClawTestState({ label: "hook-fallback-chain" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "fixture/primary", fallbacks: ["fixture/configured-backup"] },
        },
      },
    };
    const hook = vi.fn(() => ({
      providerOverride: "fixture",
      modelOverride: "local",
      fallbacksOverride: scenario.fallbacksOverride,
    }));
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "local-routing",
      hookName: "before_model_resolve",
      source: "test",
      handler: hook,
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const attempts: Array<{ model: string; final: boolean | undefined }> = [];
    const result = runEmbeddedAgentEntry({
      selection: {
        cfg,
        provider: "fixture",
        model: "primary",
        agentDir: state.agentDir(),
        ...(scenario.locked ? { fallbacksOverride: [] } : {}),
      },
      modelResolve: {
        prompt: "Synthetic local-only request",
        modelSelectionLocked: scenario.locked,
      },
      identity: { runId: `hook-${scenario.name}`, agentId: "main", sessionId: scenario.name },
      harness: {
        workspaceDir: state.workspaceDir,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => "openclaw",
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        attempts.push({ model, final: options.isFinalFallbackAttempt });
        if (attempts.length === 1) {
          throw new FailoverError("Synthetic local endpoint unavailable", { reason: "timeout" });
        }
        return makeResult({ provider, model });
      },
    });
    if (scenario.succeeds) {
      expect((await result).result.payloads).toEqual([{ text: "recovered" }]);
    } else {
      await expect(result).rejects.toThrow("Synthetic local endpoint unavailable");
    }
    expect(attempts).toEqual(
      scenario.expected.map((model, index) => ({
        model,
        final: index === scenario.expected.length - 1,
      })),
    );
    expect(hook).toHaveBeenCalledTimes(scenario.locked ? 0 : 1);
  });
});
