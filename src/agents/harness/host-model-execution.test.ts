import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, onTestFinished, vi } from "vitest";
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
import { prepareOperatorModelPolicy } from "../operator-model-policy.js";
import { makeEmbeddedRunnerAttempt } from "../test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { createAgentHarnessHostCapabilities } from "./host-capability.js";
import { getRegisteredAgentHarness, registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt, runAgentHarnessSettledTurnFinalization } from "./selection.js";
import { createHarnessAttemptParams } from "./selection.test-support.js";
import type { AgentHarness } from "./types.js";
type ModelPolicy = ReturnType<typeof prepareOperatorModelPolicy>;
type HarnessMode = "fresh" | "host" | "native";

const cfg = { agents: { defaults: { model: "fixture/a" } } };
const permittedModel = { provider: "fixture", model: "a" };
const deniedModel = "operator role cannot use this model";
const inactive = "no longer active";
const policy = prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] });
const result = makeEmbeddedRunnerAttempt({
  sessionIdUsed: "session-1",
  assistantTexts: ["done"],
});

function createAuthority(modelPolicy: ModelPolicy | undefined, signal?: AbortSignal) {
  const state = { modelPolicy, holds: 0, listeners: new Set<() => void>() };
  const source = createAdmittedRunOperatorAuthority({
    profileId: "model-policy-fixture",
    scopes: ["operator.write"],
    signal,
    assertCurrent() {},
    get modelPolicy() {
      return state.modelPolicy;
    },
    onModelPolicyChanged(listener) {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    retain() {
      state.holds++;
      return () => {
        state.holds--;
      };
    },
  });
  return {
    source,
    state,
    update(this: void, next: ModelPolicy | undefined) {
      state.modelPolicy = next;
      for (const listener of state.listeners) {
        listener();
      }
    },
  };
}

async function createHarness(mode: HarnessMode, restricted: boolean, exact: boolean) {
  const authority = createAuthority(restricted ? policy : undefined);
  const { source, state } = authority;
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
  onTestFinished(() => {
    admission.close();
    restoreActivePluginRegistrySnapshot(registrySnapshot);
    expect([state.holds, state.listeners.size]).toEqual([0, 0]);
  });
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
  const registration = expectDefined(getRegisteredAgentHarness("fixture"), "fixture harness");
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
  return {
    execute: () => runAgentHarnessAttempt(attempt, native),
    attempt,
    native,
    finalize: () => runAgentHarnessSettledTurnFinalization(attempt, result, registration.harness),
    finalizeSettledTurn,
    runAttempt,
    restrict: () => authority.update(policy),
    state,
  };
}

type HarnessOperation = "execution" | "finalization";
it.each([true, false])("prepares web search for a known native model (%s)", async (known) => {
  const { execute, runAttempt, attempt, native } = await createHarness("native", false, true);
  if (!native || native.auth !== "native") {
    throw new Error("Expected native model ownership");
  }
  native.modelRef = known ? { provider: "native", model: "bound" } : undefined;
  attempt.config = { tools: { byProvider: { native: { deny: ["web_search"] } } } };
  await execute();
  expect(runAttempt.mock.calls[0]?.[0].preparedWebSearchPolicy).toEqual(
    known
      ? {
          allowed: false,
          persistentAllowed: false,
          modelRef: { provider: "native", model: "bound" },
          requesterFacts: [],
        }
      : { allowed: false, persistentAllowed: false },
  );
});

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
  async (operation, mode, restricted, exact) => {
    const { execute, finalize, runAttempt, finalizeSettledTurn, state } = await createHarness(
      mode,
      restricted,
      exact,
    );
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
        expect([state.holds, state.listeners.size]).toEqual([1, 0]);
      }
    }
  },
);

const cancellationCases: Array<[HarnessOperation, HarnessMode]> = [
  ["execution", "fresh"],
  ["execution", "native"],
  ["finalization", "native"],
];
it.each(cancellationCases)(
  "cancels unsupported %s through %s when a model policy is introduced",
  async (operation, mode) => {
    const { execute, finalize, runAttempt, finalizeSettledTurn, restrict, state } =
      await createHarness(mode, false, false);
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
    expect(operation === "execution" ? runAttempt : finalizeSettledTurn).toHaveBeenCalledTimes(1);
    expect([state.holds, state.listeners.size]).toEqual([1, 0]);
  },
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
    const sourceAbort = new AbortController();
    const makePolicy = (deny?: string[]) =>
      prepareOperatorModelPolicy({
        cfg: nativeConfig,
        policy: deny ? { deny } : {},
        manifestPlugins: [],
      });
    const { source, state, update } = createAuthority(
      initialPolicy ? makePolicy() : undefined,
      sourceAbort.signal,
    );
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
    onTestFinished(() => {
      for (const binding of bindings) {
        binding.release();
      }
      retained?.release();
      siblingSource?.release();
      host.close();
      admission.close();
    });
    const bindFromHost = expectDefined(host.capabilities.bindModelExecution, "host model binding");
    const bind = expectDefined(
      owner === "retained" ? retained?.bindModelExecution : bindFromHost,
      "model binding",
    );
    if (owner === "retained") {
      expectDefined(siblingSource?.bindModelExecution, "independently retained model binding");
      expect(retained?.modelPolicyRequired).toBe(initialPolicy);
      host.close();
      admission.close();
    }
    if (initialPolicy) {
      expect(() => bind({ provider: "fixture", model: "denied" })).toThrow(deniedModel);
    }
    const acquire = (model: string, bindModel = bind) => {
      const binding = expectDefined(bindModel({ provider: "fixture", model }), "model execution");
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
    expect(state.holds).toBe(bindings.length + (retained ? 2 : 0));
    for (const binding of bindings) {
      expect(binding.signal.aborted).toBe(false);
      expect(binding.assertCurrent).not.toThrow();
    }
    expect(() => bindFromHost({ provider: "fixture", model: "b" })).toThrow(inactive);

    update(makePolicy());
    if (outsideDefaults) {
      expect(outsideDefaults.signal.aborted).toBe(true);
      expect(outsideDefaults.assertCurrent).toThrow(deniedModel);
    }
    if (retained) {
      expect(retained.modelPolicyRequired).toBe(true);
    }
    expect(a.assertCurrent).not.toThrow();
    expect(b.assertCurrent).not.toThrow();

    update(makePolicy(["fixture/a"]));
    expect(a.signal.aborted).toBe(true);
    expect(a.assertCurrent).toThrow(deniedModel);
    expect(b.signal.aborted).toBe(false);
    expect(b.assertCurrent).not.toThrow();
    expect(sourceAbort.signal.aborted).toBe(false);
    expect(source.assertCurrent).not.toThrow();
    if (retained) {
      expect(() => bind({ provider: "fixture", model: "a" })).toThrow(deniedModel);
    }

    update(undefined);
    expect(a.assertCurrent).toThrow(deniedModel);
    expect(b.assertCurrent).not.toThrow();
    a.release();
    b.release();
    outsideDefaults?.release();
    expect(b.signal.aborted).toBe(false);
    expect(b.assertCurrent).toThrow(inactive);
    expect(current.assertCurrent).not.toThrow();

    if (retained && sibling) {
      expect(retained.modelPolicyRequired).toBe(false);
      retained.release();
      expect(current.signal.aborted).toBe(true);
      expect(current.assertCurrent).toThrow(inactive);
      expect(() => retained.modelPolicyRequired).toThrow(inactive);
      expect(() => bind({ provider: "fixture", model: "b" })).toThrow(inactive);
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
    expect(active.assertCurrent).toThrow(inactive);
    retained?.release();
    siblingSource?.release();
    expect([state.listeners.size, state.holds]).toEqual([0, 0]);
  },
);
