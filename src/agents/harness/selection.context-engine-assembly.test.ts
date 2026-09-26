import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST } from "../../context-engine/host-compat.js";
import { buildContextEngineRuntimeSettings } from "../../context-engine/runtime-settings.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { resetAgentRunRegistryForTest } from "../../infra/agent-run-registry.js";
import { resetPluginRuntimeStateForTest } from "../../plugins/runtime.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import {
  createOperationalRunInstanceRef,
  prepareAgentRunAdmission,
  type AdmittedRunContext,
  type PreparedAgentRunAdmission,
} from "../admitted-run-context.js";
import { assembleHarnessContextEngine } from "./context-engine-lifecycle.js";
import {
  clearAgentHarnesses,
  getRegisteredAgentHarness,
  registerAgentHarness,
} from "./registry.js";
import { runAgentHarnessAttempt } from "./selection.js";
import {
  createAttemptResult,
  createHarnessAttemptParams,
  createTranscriptAnchor,
  createTranscriptRecorder,
  providerRuntimeConfig,
} from "./selection.test-support.js";

vi.mock("./builtin-openclaw.js", () => ({
  createOpenClawAgentHarness: () => {
    throw new Error("Native assembly must use the registered harness");
  },
  isBuiltInOpenClawAgentHarness: () => false,
}));

let state: OpenClawTestState;
let runAdmission: PreparedAgentRunAdmission;
let admittedRunContext: AdmittedRunContext;

beforeEach(async () => {
  state = await createOpenClawTestState({ label: "harness-context-engine-assembly" });
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
  runAdmission = prepareAgentRunAdmission({
    cfg: {},
    facts: {
      runId: "assembly-run",
      agentId: "main",
      ingress: { kind: "system", boundary: "harness-assembly-test", state: "present" },
    },
    operationalRunInstance: createOperationalRunInstanceRef("assembly-run"),
  });
  admittedRunContext = await runAdmission.admit("plugin-harness", "harness-assembly-test");
});

afterEach(async () => {
  runAdmission.close();
  clearAgentHarnesses();
  resetAgentRunRegistryForTest();
  resetPluginRuntimeStateForTest();
  await state.cleanup();
});

describe("registered harness context-engine assembly", () => {
  it.each(["supplied", "derived"] as const)(
    "retains %s native assembly settings only for the attempt that assembled",
    async (settingsSource) => {
      const admission = {
        ...createTranscriptAnchor("user-1", 1, 0),
        logicalTurnId: "assembly-budget-turn",
        role: "user" as const,
      };
      const terminal = createTranscriptAnchor("assistant-1", 2, 1);
      const params = createHarnessAttemptParams(
        admittedRunContext,
        providerRuntimeConfig("codex", "codex"),
      );
      const onContextEngineTurnCandidate = vi.fn();
      const settings = buildContextEngineRuntimeSettings({
        contextEngineHost: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST,
        provider: "native-provider",
        resolvedModel: "native-model",
        selectedContextEngineId: "assembly-engine",
        promptTokenBudget: 272_000,
      });
      const expectedSettings = structuredClone(settings);
      Object.assign(settings, { pluginPrivateState: { complete: () => undefined } });
      Object.assign(settings.model, { pluginPrivateRoute: "fixture-private-route" });
      const engine: ContextEngine = {
        info: { id: "assembly-engine", name: "Assembly engine" },
        ingest: async () => ({ ingested: true }),
        compact: async () => ({ ok: true, compacted: false }),
        assemble: async ({ messages, runtimeSettings }) => {
          // A plugin must not be able to mutate the retained host snapshot.
          if (runtimeSettings) {
            runtimeSettings.limits.promptTokenBudget = 1;
          }
          return { messages, estimatedTokens: 0 };
        },
      };
      let shouldAssemble = true;
      registerAgentHarness(
        {
          id: "codex",
          label: "Codex",
          contextEngineHostCapabilities: OPENCLAW_EMBEDDED_CONTEXT_ENGINE_HOST.capabilities,
          supports: () => ({ supported: true, priority: 100 }),
          runAttempt: async (attempt) => {
            if (shouldAssemble) {
              await assembleHarnessContextEngine({
                contextEngine: attempt.contextEngine,
                sessionId: attempt.sessionId,
                sessionKey: attempt.sessionKey,
                messages: [],
                modelId: "native-model",
                providerId: "native-provider",
                ...(settingsSource === "supplied"
                  ? { runtimeSettings: settings }
                  : { tokenBudget: 272_000 }),
              });
            }
            return {
              ...createAttemptResult(attempt.sessionId),
              runtimeModelSelection: { provider: "native-provider", model: "native-model" },
              contextEngineTerminalAnchor: terminal,
            };
          },
        },
        { ownerPluginId: "codex" },
      );
      const registration = getRegisteredAgentHarness("codex");
      if (!registration) {
        throw new Error("expected registered Codex harness");
      }
      params.contextEngine = engine;
      params.sessionKey = admission.sessionKey;
      params.modelContextWindow = 200_000;
      params.contextTokenBudget = 180_000;
      params.userTurnTranscriptRecorder = createTranscriptRecorder(admission);
      params.onContextEngineTurnCandidate = onContextEngineTurnCandidate;
      const nativeRuntime = {
        harness: registration.harness,
        auth: "native" as const,
        assertCurrent: async () => {},
      };

      await runAgentHarnessAttempt(params, nativeRuntime);

      expect(onContextEngineTurnCandidate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          runtimeSettings: expectedSettings,
          runtimeContext: {
            provider: "native-provider",
            modelId: "native-model",
            tokenBudget: 272_000,
          },
        }),
      );
      shouldAssemble = false;
      await runAgentHarnessAttempt(params, nativeRuntime);
      const nextCandidate = onContextEngineTurnCandidate.mock.calls.at(-1)?.[0];
      expect(nextCandidate.runtimeSettings).toBeUndefined();
      expect(nextCandidate.runtimeContext).toEqual({
        provider: "native-provider",
        modelId: "native-model",
      });
    },
  );
});
