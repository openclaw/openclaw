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
import { getRegisteredAgentHarness, registerAgentHarness } from "./registry.js";
import { runAgentHarnessAttempt, runAgentHarnessSettledTurnFinalization } from "./selection.js";
import { createHarnessAttemptParams } from "./selection.test-support.js";
import type { AgentHarness } from "./types.js";

const cfg = { agents: { defaults: { model: "fixture/a" } } };
const permittedModel = { provider: "fixture", model: "a" };
const policy = prepareOperatorModelPolicy({ cfg, policy: {}, manifestPlugins: [] });
const result: EmbeddedRunAttemptResult = {
  terminal: { kind: "ok" },
  sessionIdUsed: "session-1",
  messagesSnapshot: [],
  assistantTexts: ["done"],
  toolMetas: [],
  lastAssistant: undefined,
  didSendViaMessagingTool: false,
  messagingToolSentTexts: [],
  messagingToolSentMediaUrls: [],
  messagingToolSentTargets: [],
  cloudCodeAssistFormatError: false,
  replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
  itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
};

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

it.each(["fresh", "host", "native"] as const)(
  "rejects unsupported restricted %s execution before invoking the harness",
  async (mode) =>
    withHarness(mode, true, false, async ({ execute, runAttempt }) => {
      await expect(execute()).rejects.toThrow("cannot enforce your operator role's model policy");
      expect(runAttempt).not.toHaveBeenCalled();
    }),
);

it.each(["fresh", "host", "native"] as const)(
  "preserves unsupported %s execution without a model policy",
  async (mode) =>
    withHarness(mode, false, false, async ({ execute, runAttempt, listeners, sourceHolds }) => {
      expect((await execute()).assistantTexts).toEqual(["done"]);
      expect(runAttempt).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(0);
      expect(sourceHolds()).toBe(1);
    }),
);

it.each(["fresh", "host", "native"] as const)(
  "admits exact model-policy support for %s execution",
  async (mode) =>
    withHarness(mode, true, true, async ({ execute, runAttempt }) => {
      expect((await execute()).assistantTexts).toEqual(["done"]);
      expect(runAttempt).toHaveBeenCalledTimes(1);
    }),
);

it.each(["fresh", "host", "native"] as const)(
  "cancels unsupported %s work when a policy is introduced even if its outer model is allowed",
  async (mode) =>
    withHarness(
      mode,
      false,
      false,
      async ({ execute, runAttempt, restrict, listeners, sourceHolds }) => {
        runAttempt.mockImplementation(async (attempt) => {
          expect(attempt.abortSignal?.aborted).toBe(false);
          restrict();
          expect(attempt.abortSignal?.aborted).toBe(true);
          return result;
        });
        await expect(execute()).rejects.toThrow("operator role cannot use this model");
        expect(runAttempt).toHaveBeenCalledTimes(1);
        expect(listeners.size).toBe(0);
        expect(sourceHolds()).toBe(1);
      },
    ),
);

it.each([false, true])("checks unsupported finalization with model policy=%s", async (restricted) =>
  withHarness("native", restricted, false, async ({ finalize, finalizeSettledTurn }) => {
    await expect(finalize()).rejects.toThrow(
      restricted
        ? "cannot enforce your operator role's model policy"
        : "fixture finalization reached",
    );
    expect(finalizeSettledTurn).toHaveBeenCalledTimes(restricted ? 0 : 1);
  }),
);

it("cancels unsupported finalization when a model policy is introduced", async () =>
  withHarness(
    "native",
    false,
    false,
    async ({ finalize, finalizeSettledTurn, restrict, listeners, sourceHolds }) => {
      finalizeSettledTurn.mockImplementation(async ({ attempt }) => {
        expect(attempt.abortSignal?.aborted).toBe(false);
        restrict();
        expect(attempt.abortSignal?.aborted).toBe(true);
        attempt.abortSignal?.throwIfAborted();
        throw new Error("finalization must be canceled");
      });
      await expect(finalize()).rejects.toThrow("operator role cannot use this model");
      expect(finalizeSettledTurn).toHaveBeenCalledTimes(1);
      expect(listeners.size).toBe(0);
      expect(sourceHolds()).toBe(1);
    },
  ));
