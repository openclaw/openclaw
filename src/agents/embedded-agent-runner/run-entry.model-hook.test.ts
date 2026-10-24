import { afterEach, expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import { setRuntimeConfigSnapshot } from "../../config/runtime-snapshot.js";
import { withClaimingHookAdmission } from "../../plugins/hook-claim-admission.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { FailoverError } from "../failover-error.js";
import { resetFallbackSkipCacheForTest } from "../fallback-skip-cache.test-support.js";
import { createModelFallbackConfig } from "../test-helpers/model-fallback-config-fixture.js";
import { runEmbeddedAgentEntry } from "./run-entry.js";
import { createDirectHarness, makeResult } from "./run-entry.test-support.js";

vi.mock("../auth-profiles/source-check.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../auth-profiles/source-check.js")>()),
  hasAnyAuthProfileStoreSourceAsync: async () => false,
}));

afterEach(() => {
  resetGlobalHookRunner();
  resetPluginRuntimeStateForTest();
  resetFallbackSkipCacheForTest();
});

it.each<[string, string[] | undefined, string[], boolean, boolean]>([
  ["empty", [], ["local"], false, false],
  ["local-only", ["fixture/local-backup"], ["local", "local-backup"], true, false],
  ["null", null as unknown as string[], ["local"], false, false],
  ["bare string", "fixture/local-backup" as unknown as string[], ["local"], false, false],
  ["omitted", undefined, ["primary", "configured-backup"], true, false],
  ["locked", ["fixture/local-backup"], ["primary"], false, true],
])(
  "uses the %s hook fallback chain at the logical run boundary",
  async (name, fallbacksOverride, expected, succeeds, locked) => {
    await withOpenClawTestState({ label: "hook-fallback-chain" }, async (state) => {
      const cfg = createModelFallbackConfig("fixture/primary", ["fixture/configured-backup"]);
      setRuntimeConfigSnapshot(cfg);
      const dispatchOrder: string[] = [];
      const hook = vi.fn(() => {
        dispatchOrder.push("hook");
        return {
          providerOverride: "fixture",
          modelOverride: "local",
          fallbacksOverride,
        };
      });
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
      const capture = createDeferred();
      const captureAwaited = createDeferred();
      const result = runEmbeddedAgentEntry({
        selection: {
          cfg,
          provider: "fixture",
          model: "primary",
          agentDir: state.agentDir(),
          ...(locked ? { fallbacksOverride: [] } : {}),
        },
        modelResolve: {
          prompt: "Synthetic local-only request",
          context: withClaimingHookAdmission(
            {},
            { prepare: async () => void dispatchOrder.push("adopt") },
          ),
          modelSelectionLocked: locked,
          awaitSessionDiffBaseline: () => {
            captureAwaited.resolve();
            return capture.promise;
          },
        },
        identity: { runId: `hook-${name}`, agentId: "main", sessionId: name },
        harness: createDirectHarness(state.workspaceDir, "openclaw"),
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
      if (!locked) {
        try {
          await awaitGateBeforeSettlement(
            captureAwaited.promise,
            result,
            "model selection ran without awaiting capture",
          );
          expect(hook).not.toHaveBeenCalled();
        } finally {
          capture.resolve();
        }
      }
      if (succeeds) {
        expect((await result).result.payloads).toEqual([{ text: "recovered" }]);
      } else {
        await expect(result).rejects.toThrow("Synthetic local endpoint unavailable");
      }
      expect(dispatchOrder).toEqual(locked ? [] : ["adopt", "hook"]);
      expect(attempts).toEqual(
        expected.map((model, index) => ({
          model,
          final: index === expected.length - 1,
        })),
      );
      expect(hook).toHaveBeenCalledTimes(locked ? 0 : 1);
    });
  },
);
