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
  {
    name: "hook-supplied",
    hookFallbacks: ["fixture/peer-b", "fixture/peer-c"],
    expected: ["local", "peer-b", "peer-c"],
    source: undefined,
  },
  {
    name: "omitted",
    hookFallbacks: undefined,
    expected: ["primary", "peer-c", "peer-b"],
    source: "configured",
  },
])("applies configured priority only without a $name hook chain", async (scenario) => {
  await withOpenClawTestState({ label: "hook-fallback-priority" }, async (state) => {
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          workspace: state.workspaceDir,
          model: { primary: "fixture/primary" },
          models: {
            "fixture/primary": { fallbackPriority: ["fixture/peer-c"] },
            "fixture/local": { fallbackPriority: ["fixture/peer-c"] },
          },
        },
      },
    };
    const hook = vi.fn(() =>
      scenario.hookFallbacks
        ? {
            providerOverride: "fixture",
            modelOverride: "local",
            fallbacksOverride: scenario.hookFallbacks,
          }
        : {},
    );
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "local-routing",
      hookName: "before_model_resolve",
      source: "test",
      handler: hook,
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const attempts: Array<{ model: string; source: string | undefined }> = [];
    await runEmbeddedAgentEntry({
      selection: {
        cfg,
        provider: "fixture",
        model: "primary",
        agentDir: state.agentDir(),
        // Session-configured chain projected into an override, as reply, command and cron pass it.
        fallbacksOverride: ["fixture/peer-b", "fixture/peer-c"],
        fallbacksOverrideSource: "configured",
      },
      modelResolve: { prompt: "Synthetic routing request" },
      identity: {
        runId: `hook-priority-${scenario.name}`,
        agentId: "main",
        sessionId: scenario.name,
      },
      harness: {
        workspaceDir: state.workspaceDir,
        preparation: { kind: "direct" },
        resolveRuntimeOverride: () => "openclaw",
      },
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      runCandidate: async (provider, model, options) => {
        attempts.push({ model, source: options.modelFallbacksOverrideSource });
        if (attempts.length < 3) {
          throw new FailoverError("Synthetic endpoint unavailable", { reason: "timeout" });
        }
        return makeResult({ provider, model });
      },
    });
    // A hook-supplied chain is caller-owned: absolute order and no configured provenance.
    expect(attempts).toEqual(
      scenario.expected.map((model) => ({ model, source: scenario.source })),
    );
    expect(hook).toHaveBeenCalledTimes(1);
  });
});
