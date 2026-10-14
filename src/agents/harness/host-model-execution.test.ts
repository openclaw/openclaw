import { expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../../plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../plugins/runtime.js";
import {
  createAdmittedRunOperatorAuthority,
  prepareSystemAgentRunAdmission,
} from "../admitted-run-context.js";
import type { PreparedNativeSessionRuntime } from "../embedded-agent-runner/run/model-setup.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt, runAgentHarnessSettledTurnFinalization } from "./selection.js";
import { createHarnessAttemptParams } from "./selection.test-support.js";
import type { AgentHarness } from "./types.js";

const cfg = { agents: { defaults: { model: "fixture/a" } } };
const permittedModel = { provider: "fixture", model: "a" };
const policy = prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] });
const result = makeEmbeddedRunnerAttempt({
  sessionIdUsed: "session-1",
  assistantTexts: ["done"],
});

async function withHarness(
  mode: "fresh" | "host" | "native",
  restricted: boolean,
  exact: boolean,
  run: (fixture: {
    execute: () => Promise<EmbeddedRunAttemptResult>;
    finalize: () => Promise<unknown>;
    finalizeSettledTurn: ReturnType<typeof vi.fn<NonNullable<AgentHarness["finalizeSettledTurn"]>>>;
    runAttempt: ReturnType<typeof vi.fn<AgentHarness["runAttempt"]>>;
    restrict: () => void;
    listeners: Set<() => void>;
    sourceHolds: () => number;
  }) => Promise<void>,
) {
  let currentPolicy = restricted ? policy : undefined;
  let holds = 0;
  const listeners = new Set<() => void>();
  const source = createAdmittedRunOperatorAuthority({
    profileId: "model-policy-fixture",
    scopes: ["operator.write"],
    assertCurrent: () => {},
    get modelPolicy() {
      return currentPolicy;
    },
    onModelPolicyChanged: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    retain: () => {
      holds += 1;
      return () => {
        holds -= 1;
      };
    },
  });
  const admission = prepareSystemAgentRunAdmission(
    cfg,
    "model-policy",
    "main",
    "test",
    undefined,
    source,
  );
  const runAttempt = vi.fn<AgentHarness["runAttempt"]>(async () => result);
  const finalizeSettledTurn = vi.fn<NonNullable<AgentHarness["finalizeSettledTurn"]>>(async () => {
    throw new Error("fixture finalization reached");
  });
  const registrySnapshot = captureActivePluginRegistrySnapshot();
  try {
    setActivePluginRegistry(createEmptyPluginRegistry());
    registerAgentHarness(
      {
        id: "fixture",
        label: "Fixture",
        supports: () => ({ supported: true }),
        ...(exact ? { nativeModelPolicySupport: "exact" as const } : {}),
        runAttempt,
        finalizeSettledTurn,
      },
      { ownerPluginId: "fixture" },
    );
    const registration = getRegisteredAgentHarness("fixture");
    if (!registration) {
      throw new Error("missing registered fixture harness");
    }
    const attempt = {
      ...createHarnessAttemptParams(await admission.admit("plugin-harness", "fixture"), cfg),
      provider: permittedModel.provider,
      modelId: permittedModel.model,
      model: { id: permittedModel.model, provider: permittedModel.provider } as ReturnType<
        typeof createHarnessAttemptParams
      >["model"],
      agentHarnessRuntimeOverride: "fixture",
    };
    const native: PreparedNativeSessionRuntime | undefined =
      mode === "fresh"
        ? undefined
        : {
            auth: mode,
            modelRef: permittedModel,
            assertCurrent: async () => {},
            harness: registration.harness,
          };
    await run({
      execute: () => runAgentHarnessAttempt(attempt, native),
      finalize: () => runAgentHarnessSettledTurnFinalization(attempt, result, registration.harness),
      finalizeSettledTurn,
      runAttempt,
      restrict: () => {
        currentPolicy = policy;
        for (const listener of listeners) {
          listener();
        }
      },
      listeners,
      sourceHolds: () => holds,
    });
  } finally {
    admission.close();
    restoreActivePluginRegistrySnapshot(registrySnapshot);
  }
  expect(holds).toBe(0);
  expect(listeners.size).toBe(0);
}

type HarnessOperation = "execution" | "finalization";
type HarnessMode = Parameters<typeof withHarness>[0];
const admissionCases: Array<[HarnessOperation, HarnessMode, boolean, boolean]> = [
  ["execution", "fresh", true, false],
  ["execution", "native", true, false],
  ["execution", "fresh", false, false],
  ["execution", "native", false, false],
  ["execution", "fresh", true, true],
  ["execution", "host", true, true],
  ["execution", "native", true, true],
  ["finalization", "native", false, false],
  ["finalization", "native", true, false],
];

it.each(admissionCases)(
  "checks %s admission for %s with model policy=%s and exact support=%s",
  async (operation, mode, restricted, exact) =>
    withHarness(
      mode,
      restricted,
      exact,
      async ({ execute, finalize, runAttempt, finalizeSettledTurn, listeners, sourceHolds }) => {
        const unsupported = "cannot enforce your operator role's model policy";
        if (operation === "finalization") {
          await expect(finalize()).rejects.toThrow(
            restricted ? unsupported : "fixture finalization reached",
          );
          expect(finalizeSettledTurn).toHaveBeenCalledTimes(restricted ? 0 : 1);
        } else if (restricted && !exact) {
          await expect(execute()).rejects.toThrow(unsupported);
          expect(runAttempt).not.toHaveBeenCalled();
        } else {
          expect((await execute()).assistantTexts).toEqual(["done"]);
          expect(runAttempt).toHaveBeenCalledTimes(1);
          if (!restricted) {
            expect(listeners.size).toBe(0);
            expect(sourceHolds()).toBe(1);
          }
        }
      },
    ),
);

const cancellationCases: Array<[HarnessOperation, HarnessMode]> = [
  ["execution", "fresh"],
  ["execution", "native"],
  ["finalization", "native"],
];
it.each(cancellationCases)(
  "cancels unsupported %s through %s when a model policy is introduced",
  async (operation, mode) =>
    withHarness(
      mode,
      false,
      false,
      async ({
        execute,
        finalize,
        runAttempt,
        finalizeSettledTurn,
        restrict,
        listeners,
        sourceHolds,
      }) => {
        const introducePolicy = (signal: AbortSignal | undefined) => {
          expect(signal?.aborted).toBe(false);
          restrict();
          expect(signal?.aborted).toBe(true);
        };
        if (operation === "execution") {
          runAttempt.mockImplementation(async (attempt) => {
            introducePolicy(attempt.abortSignal);
            return result;
          });
        } else {
          finalizeSettledTurn.mockImplementation(async ({ attempt }) => {
            introducePolicy(attempt.abortSignal);
            attempt.abortSignal?.throwIfAborted();
            throw new Error("finalization must be canceled");
          });
        }
        await expect((operation === "execution" ? execute : finalize)()).rejects.toThrow(
          "operator role cannot use this model",
        );
        expect(operation === "execution" ? runAttempt : finalizeSettledTurn).toHaveBeenCalledTimes(
          1,
        );
        expect(listeners.size).toBe(0);
        expect(sourceHolds()).toBe(1);
      },
    ),
);

it.each([
  ["foreground", false],
  ["foreground", true],
  ["retained", false],
  ["retained", true],
] as const)(
  "retains native model bindings across foreground closure (%s owner, initial policy: %s)",
  async (owner, initialPolicy) => {
    const nativeConfig = {
      agents: { defaults: { model: { primary: "fixture/a", fallbacks: ["fixture/b"] } } },
    };
    let nativePolicy = initialPolicy
      ? prepareOperatorModelPolicy({ cfg: nativeConfig, policy: {}, manifestPlugins: [] })
      : undefined;
    const listeners = new Set<() => void>();
    const sourceAbort = new AbortController();
    let retainedSources = 0;
    const source = createAdmittedRunOperatorAuthority({
      profileId: "native-model-fixture",
      scopes: ["operator.write"],
      signal: sourceAbort.signal,
      assertCurrent: () => {},
      retain: () => {
        retainedSources += 1;
        return () => {
          retainedSources -= 1;
        };
      },
      get modelPolicy() {
        return nativePolicy;
      },
      onModelPolicyChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const admission = prepareSystemAgentRunAdmission(
      nativeConfig,
      "native-model-execution",
      "main",
      "test",
      undefined,
      source,
    );
    const host = createAgentHarnessHostCapabilities({
      attempt: {
        admittedRunContext: await admission.admit("plugin-harness", "fixture"),
        runId: "native-model-execution",
        agentId: "main",
      },
      pluginId: "fixture",
      nativeModelPolicySupport: "exact",
    });
    const bindings: Array<
      NonNullable<ReturnType<NonNullable<typeof host.capabilities.bindModelExecution>>>
    > = [];
    const retained = owner === "retained" ? host.capabilities.retainSourceAuthority?.() : undefined;
    const siblingSource =
      owner === "retained" ? host.capabilities.retainSourceAuthority?.() : undefined;
    try {
      const bindFromHost = host.capabilities.bindModelExecution;
      const bind = owner === "retained" ? retained?.bindModelExecution : bindFromHost;
      if (!bind || !bindFromHost) {
        throw new Error("missing host model execution capability");
      }
      if (owner === "retained") {
        if (!siblingSource?.bindModelExecution) {
          throw new Error("missing independently retained model execution capability");
        }
        expect(retained?.modelPolicyRequired).toBe(initialPolicy);
        host.close();
        admission.close();
      }
      if (initialPolicy) {
        expect(() => bind({ provider: "fixture", model: "denied" })).toThrow(
          "operator role cannot use this model",
        );
      }
      const acquire = (model: string, bindModel = bind) => {
        const binding = bindModel({ provider: "fixture", model });
        if (!binding) {
          throw new Error("missing operator model execution binding");
        }
        bindings.push(binding);
        return binding;
      };
      const a = acquire("a");
      const b = acquire("b");
      const current = acquire("b");
      const outsideDefaults = initialPolicy ? undefined : acquire("denied");
      const sibling = siblingSource?.bindModelExecution
        ? acquire("b", siblingSource.bindModelExecution)
        : undefined;

      host.close();
      admission.close();
      expect(retainedSources).toBe(bindings.length + (retained ? 2 : 0));
      for (const binding of bindings) {
        expect(binding.signal.aborted).toBe(false);
        expect(binding.assertCurrent).not.toThrow();
      }
      expect(() => bindFromHost({ provider: "fixture", model: "b" })).toThrow("no longer active");

      nativePolicy = prepareOperatorModelPolicy({
        cfg: nativeConfig,
        policy: {},
        manifestPlugins: [],
      });
      for (const listener of listeners) {
        listener();
      }
      if (outsideDefaults) {
        expect(outsideDefaults.signal.aborted).toBe(true);
        expect(outsideDefaults.assertCurrent).toThrow("operator role cannot use this model");
      }
      if (retained) {
        expect(retained.modelPolicyRequired).toBe(true);
      }
      expect(a.assertCurrent).not.toThrow();
      expect(b.assertCurrent).not.toThrow();

      nativePolicy = prepareOperatorModelPolicy({
        cfg: nativeConfig,
        policy: { deny: ["fixture/a"] },
        manifestPlugins: [],
      });
      for (const listener of listeners) {
        listener();
      }
      expect(a.signal.aborted).toBe(true);
      expect(a.assertCurrent).toThrow("operator role cannot use this model");
      expect(b.signal.aborted).toBe(false);
      expect(b.assertCurrent).not.toThrow();
      expect(sourceAbort.signal.aborted).toBe(false);
      expect(source.assertCurrent).not.toThrow();
      if (retained) {
        expect(() => bind({ provider: "fixture", model: "a" })).toThrow(
          "operator role cannot use this model",
        );
      }

      nativePolicy = undefined;
      for (const listener of listeners) {
        listener();
      }
      expect(a.assertCurrent).toThrow("operator role cannot use this model");
      expect(b.assertCurrent).not.toThrow();
      a.release();
      b.release();
      outsideDefaults?.release();
      expect(b.signal.aborted).toBe(false);
      expect(b.assertCurrent).toThrow("no longer active");
      expect(current.assertCurrent).not.toThrow();

      if (retained && sibling) {
        expect(retained.modelPolicyRequired).toBe(false);
        retained.release();
        expect(current.signal.aborted).toBe(true);
        expect(current.assertCurrent).toThrow("no longer active");
        expect(() => retained.modelPolicyRequired).toThrow("no longer active");
        expect(() => bind({ provider: "fixture", model: "b" })).toThrow("no longer active");
        expect(sibling.signal.aborted).toBe(false);
        expect(sibling.assertCurrent).not.toThrow();
        expect(sourceAbort.signal.aborted).toBe(false);
        current.release();
      }
      const active = sibling ?? current;
      sourceAbort.abort(new Error("operator source revoked"));
      expect(active.signal.aborted).toBe(true);
      expect(active.assertCurrent).toThrow("operator source revoked");
      active.release();
      expect(active.assertCurrent).toThrow("no longer active");
      retained?.release();
      siblingSource?.release();
      expect(listeners.size).toBe(0);
      expect(retainedSources).toBe(0);
    } finally {
      for (const binding of bindings) {
        binding.release();
      }
      retained?.release();
      siblingSource?.release();
      host.close();
      admission.close();
    }
  },
);
