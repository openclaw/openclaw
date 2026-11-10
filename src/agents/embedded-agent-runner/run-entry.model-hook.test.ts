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
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
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

it("stops a late routing result when the logical run closes before admission", async () => {
  await withOpenClawTestState({ label: "hook-closed-preparation" }, async (state) => {
    const cfg = createModelFallbackConfig("fixture/primary", ["fixture/backup"]);
    setRuntimeConfigSnapshot(cfg);
    const runId = "hook-closed-preparation";
    const admission = prepareSystemAgentRunAdmission(cfg, runId, "main", "routing-test");
    const entered = createDeferred();
    const release = createDeferred();
    const registry = createEmptyPluginRegistry();
    registry.typedHooks.push({
      pluginId: "local-routing",
      hookName: "before_model_resolve",
      source: "test",
      handler: async () => {
        entered.resolve();
        await release.promise;
        return { modelOverride: "late-model" };
      },
    });
    setActivePluginRegistry(registry);
    initializeGlobalHookRunner(registry);
    const attempt = vi.fn(async (provider: string, model: string) =>
      makeResult({ provider, model }),
    );
    const pending = runEmbeddedAgentEntry({
      preparedRunAdmission: admission,
      selection: { cfg, provider: "fixture", model: "primary", agentDir: state.agentDir() },
      modelResolve: { prompt: "Synthetic canceled request" },
      identity: { runId, agentId: "main", sessionId: runId },
      harness: createDirectHarness(state.workspaceDir, "openclaw"),
      behavior: { kind: "maintenance" },
      sessionOverride: { kind: "preserve" },
      runCandidate: attempt,
    });
    try {
      await awaitGateBeforeSettlement(entered.promise, pending, "routing did not start");
      admission.close();
      release.resolve();
      await expect(pending).rejects.toMatchObject({ name: "AgentHarnessPreflightError" });
      expect(attempt).not.toHaveBeenCalled();
    } finally {
      release.resolve();
      await Promise.allSettled([pending]);
      admission.close();
    }
  });
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

it.each([undefined, [] as string[]])(
  "retries the hook-resolved model with Blue Access without changing models (%j)",
  async (fallbacksOverride) => {
    await withOpenClawTestState({ label: "hook-cyber-access" }, async (state) => {
      const cfg = createModelFallbackConfig("openai/primary", []);
      setRuntimeConfigSnapshot(cfg);
      const hook = vi.fn(() => ({
        providerOverride: "openai",
        modelOverride: "hook-selected",
        fallbacksOverride,
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
      const attempts: Array<{ model: string; access?: string }> = [];
      const result = await runEmbeddedAgentEntry({
        selection: { cfg, provider: "openai", model: "primary", agentDir: state.agentDir() },
        modelResolve: { prompt: "Synthetic cyber request" },
        identity: { runId: "hook-cyber-access", agentId: "main", sessionId: "hook-cyber" },
        harness: createDirectHarness(state.workspaceDir, "openclaw"),
        behavior: { kind: "command-rpc", hasCommittedSideEffect: () => false },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          const selected = options.resolvedModelSelection;
          const physical = {
            provider: selected?.provider ?? provider,
            model: selected?.modelId ?? model,
          };
          attempts.push({ model: physical.model, access: options.cyberAccessProgram });
          const attemptResult = makeResult(physical);
          if (!options.cyberAccessProgram) {
            attemptResult.payloads = [{ text: "policy refusal", isError: true }];
            Object.assign(attemptResult.meta.agentMeta!, {
              agentHarnessId: "openclaw",
              providerRefusal: { provider: "openai", category: "cyber" },
            });
          }
          return attemptResult;
        },
      });
      expect(attempts).toEqual([
        { model: "hook-selected", access: undefined },
        { model: "hook-selected", access: "daybreak_blue" },
      ]);
      expect(result.result.meta.agentMeta?.model).toBe("hook-selected");
      expect(hook).toHaveBeenCalledOnce();
    });
  },
);

// Single-account admission retains the pre-opt-in fallback order after a hook reroute.
it.each([
  { mode: "legacy", empty: false, expected: ["rerouted", "rerouted", "backup"] },
  { mode: "legacy", empty: true, expected: ["rerouted"] },
  { mode: "candidate accounts", empty: false, expected: ["backup"] },
])(
  "preserves hook routing for $mode admission (empty=$empty)",
  async ({ mode, empty, expected }) => {
    await withOpenClawTestState({ label: "hook-account-policy" }, async (state) => {
      const cfg = createModelFallbackConfig("fixture/primary", [
        "fixture/rerouted",
        "fixture/backup",
      ]);
      setRuntimeConfigSnapshot(cfg);
      const registry = createEmptyPluginRegistry();
      registry.typedHooks.push({
        pluginId: "local-routing",
        hookName: "before_model_resolve",
        source: "test",
        handler: () => ({ providerOverride: "fixture", modelOverride: "rerouted" }),
      });
      setActivePluginRegistry(registry);
      initializeGlobalHookRunner(registry);
      const exactAccounts = mode === "candidate accounts";
      const attempted: string[] = [];
      const pending = runEmbeddedAgentEntry({
        selection: {
          cfg,
          provider: "fixture",
          model: "primary",
          agentDir: state.agentDir(),
          ...(empty ? { fallbacksOverride: [] } : {}),
          admitCandidate: async (_provider, model) =>
            exactAccounts && model === "rerouted" ? "No recorded account authorization" : undefined,
          ...(exactAccounts ? { resolveCandidateAuthProfileId: () => undefined } : {}),
        },
        modelResolve: { prompt: "Synthetic legacy scheduled request" },
        identity: {
          runId: "hook-account-policy",
          agentId: "main",
          sessionId: "hook-account-policy",
        },
        harness: createDirectHarness(state.workspaceDir, "openclaw"),
        behavior: { kind: "maintenance" },
        sessionOverride: { kind: "preserve" },
        runCandidate: async (provider, model, options) => {
          const physicalModel = options.resolvedModelSelection?.modelId ?? model;
          attempted.push(physicalModel);
          if (physicalModel === "rerouted") {
            throw new FailoverError("Synthetic primary outage", { reason: "timeout" });
          }
          return makeResult({ provider, model: physicalModel });
        },
      });
      if (empty) {
        await expect(pending).rejects.toThrow("Synthetic primary outage");
      } else {
        expect((await pending).result.payloads).toEqual([{ text: "recovered" }]);
      }
      expect(attempted).toEqual(expected);
    });
  },
);
