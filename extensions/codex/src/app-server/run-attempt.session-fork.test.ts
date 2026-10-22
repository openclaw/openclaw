import type { AgentHarnessSideQuestionParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createAdmittedHostCapabilityTestFixture } from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterAll, expect, it, vi } from "vitest";
import { CodexAppServerClient } from "./client.js";
import { CODEX_INFERENCE_GENERATION_KEY } from "./inference-context.js";
import { createCodexInferenceModelBinding } from "./inference-dispatch.js";
import { getCodexInferenceThread, ownCodexInferenceClient } from "./inference-routing.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import { isJsonObject, type JsonObject } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createStartedThreadHarness,
  createTestParams,
  runCodexAppServerAttempt,
  setupRunAttemptTestHooks,
  threadStartResult,
  turnStartResult,
} from "./run-attempt-test-harness.js";
import { sessionBindingIdentity } from "./session-binding.js";
import { testCodexAppServerBindingStore } from "./session-binding.test-helpers.js";
import { runCodexAppServerSideQuestion } from "./side-question.js";

setupRunAttemptTestHooks();
afterAll(clearRuntimeConfigSnapshot);

const cases = [
  { completeParent: false, rebuilt: false },
  { completeParent: false, rebuilt: true },
  { completeParent: true, rebuilt: false },
  { completeParent: true, rebuilt: true },
];
const clientMetadata = (threadId: string, generation: unknown) => ({
  thread_id: threadId,
  "x-codex-turn-metadata": JSON.stringify({
    thread_id: threadId,
    request_kind: "turn",
    [CODEX_INFERENCE_GENERATION_KEY]: generation,
  }),
});

it.each(cases)("forks %j", async ({ completeParent, rebuilt }) => {
  let inferenceAdmitted = false;
  let sideRequest: JsonObject | undefined;
  const question = {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text: "Review the active task without executing tools." }],
  };
  const completed: JsonObject[] = [
    { type: "function_call", call_id: "completed-call", name: "read", arguments: "{}" },
    { type: "function_call_output", call_id: "completed-call", output: "Completed tool result" },
    { role: "assistant", content: "Completed parent answer 4837" },
  ];
  const harness = createStartedThreadHarness(
    async (method, request) => {
      if (method === "account/read") {
        return { account: { type: "apiKey" } };
      }
      if (method === "thread/fork") {
        return threadStartResult("fork-thread");
      }
      if (method === "turn/start" && isJsonObject(request) && request.threadId === "fork-thread") {
        void (async () => {
          try {
            const route = getCodexInferenceThread(harness.client, "thread-1");
            if (!route || !isJsonObject(request.responsesapiClientMetadata)) {
              throw new Error("Expected the parent's managed inference route and child admission");
            }
            sideRequest = route.context.prepare({
              instructions: "rebuilt native base",
              tools: [],
              input: [...nativeInput, ...completed, question],
              client_metadata: clientMetadata(
                "fork-thread",
                request.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY],
              ),
            }).body;
            const execution = await createCodexInferenceModelBinding({
              client: harness.client,
              provider: "openai",
              assertCurrent: () => {},
              memoryConfigured: () => false,
              captureModelSource: codexNativeSubagentMonitorRuntime.captureModelSource,
              resolveModelThreadId: codexNativeSubagentMonitorRuntime.resolveModelThreadId,
            })({
              path: "/responses",
              body: { model: "gpt-5" },
              headers: {},
              metadata: { threadId: "fork-thread", turnId: "fork-turn", requestKind: "turn" },
              transport: "http",
              signal: new AbortController().signal,
            });
            execution.assertCurrent();
            inferenceAdmitted = true;
            execution.release();
          } finally {
            await harness.notify({
              method: "turn/completed",
              params: {
                threadId: "fork-thread",
                turn: {
                  id: "fork-turn",
                  status: "completed",
                  items: [{ id: "fork-answer", type: "agentMessage", text: "Read-only review." }],
                },
              },
            });
          }
        })().catch(() => {});
        return turnStartResult("fork-turn");
      }
      return undefined;
    },
    { persistedThreads: [] },
  );
  ownCodexInferenceClient(harness.client);
  const params = createTestParams();
  params.provider = "openai";
  params.model = { ...params.model, provider: "openai", api: "openai-responses" };
  params.resolvedApiKey = "synthetic-parent-key";
  const authPlan = {
    providerForAuth: "openai",
    authProfileProviderForAuth: "openai",
    selectedAuthMode: "api-key",
    modelRoute: {
      provider: "openai",
      modelId: params.modelId,
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      authRequirement: "api-key",
      requestTransportOverrides: "none",
    },
  } satisfies AgentHarnessSideQuestionParamsV2["preparedRuntimeAuth"]["plan"];
  params.runtimePlan = { ...createCodexRuntimePlanFixture(), auth: authPlan };
  setRuntimeConfigSnapshot(params.config ?? {});
  const closeParentHost = await bindProductionHarnessHostCapabilitiesForTest(params, {
    profileId: "fork-parent-operator",
    scopes: ["operator.write"],
    assertCurrent: () => {},
  });
  const parent = runCodexAppServerAttempt(params);
  await parent.waitForTurnAccepted();
  const binding = testCodexAppServerBindingStore.read(sessionBindingIdentity(params));
  expect(binding?.clientId).toBe(harness.client.getInstanceId());
  const route = getCodexInferenceThread(harness.client, binding?.threadId ?? "thread-1");
  const parentTurn = harness.requests.find(({ method }) => method === "turn/start")?.params;
  const parentGeneration =
    isJsonObject(parentTurn) && isJsonObject(parentTurn.responsesapiClientMetadata)
      ? parentTurn.responsesapiClientMetadata[CODEX_INFERENCE_GENERATION_KEY]
      : undefined;
  if (!route || !isJsonObject(parentTurn) || typeof parentGeneration !== "string") {
    throw new Error("Expected a prepared parent inference generation");
  }
  const parentInput: JsonObject[] = [
    { role: "developer", content: "exact parent environment\n".repeat(12000) },
    { role: "user", content: "parent task" },
    { role: "assistant", content: "tool round" },
    { type: "function_call_output", call_id: "parent-call", output: "exact tool result" },
  ];
  const nativeInput = rebuilt
    ? [{ role: "developer", content: "rebuilt environment" }, ...parentInput.slice(1)]
    : parentInput;
  const parentRequest: JsonObject = {
    instructions: "native base",
    tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
    input: parentInput,
    client_metadata: clientMetadata(binding?.threadId ?? "thread-1", parentGeneration),
  };
  route.context.prepare({ ...parentRequest, input: [] });
  const expectedRequest = route.context.prepare(parentRequest).body;
  if (completeParent) {
    await harness.completeTurn({ threadId: binding?.threadId ?? "thread-1", turnId: "turn-1" });
    await parent;
    closeParentHost();
    expect(() => params.hostCapabilities.assertActive()).toThrow(
      "agent harness host capability is no longer active",
    );
    expect(() => route.context.prepare(parentRequest)).toThrow("current admitted");
  }
  // A separately prepared side credential must not replace the bound physical owner.
  const start = vi
    .spyOn(CodexAppServerClient, "start")
    .mockClear()
    .mockRejectedValue(new Error("Session fork attempted to acquire a replacement client"));
  const host = await createAdmittedHostCapabilityTestFixture(
    { runId: "session-fork" },
    { toolCalls: "deny" },
  );
  const side: AgentHarnessSideQuestionParamsV2 = {
    cfg: params.config ?? {},
    agentDir: params.agentDir ?? params.workspaceDir,
    agentId: params.agentId,
    provider: "openai",
    model: params.modelId,
    runtimeModel: params.model,
    question: "Review the active task without executing tools.",
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    sessionFile: params.sessionFile,
    sessionEntry: { sessionId: params.sessionId, updatedAt: 1 },
    workspaceDir: params.workspaceDir,
    resolvedReasoningLevel: "off",
    isNewSession: false,
    toolCalls: "deny",
    hostCapabilities: host.hostCapabilities,
    opts: { runId: "session-fork" },
    preparedRuntimeAuth: {
      plan: authPlan,
      authProfileStore: params.authProfileStore ?? { version: 1, profiles: {} },
      authStorage: params.authStorage,
      modelRegistry: params.modelRegistry,
      resolvedApiKey: "synthetic-fork-key",
    },
  };
  try {
    await expect(
      runCodexAppServerSideQuestion(side, {
        bindingStore: testCodexAppServerBindingStore,
        nativeHookRelay: { enabled: true },
      }),
    ).resolves.toMatchObject({ text: "Read-only review." });
    expect(start).not.toHaveBeenCalled();
    expect(inferenceAdmitted).toBe(true);
    expect(sideRequest?.instructions).toBe(expectedRequest.instructions);
    expect(sideRequest?.tools).toEqual(expectedRequest.tools);
    expect(sideRequest?.input).toEqual([...nativeInput, ...completed, question]);
    expect(sideRequest?.tool_choice).toBe("none");
    expect(
      await codexNativeSubagentMonitorRuntime.captureModelSource({
        client: harness.client,
        threadId: "fork-thread",
        turnId: "fork-turn",
      }),
    ).toBeUndefined();
    const parentStart = harness.requests.find(({ method }) => method === "thread/start");
    const fork = harness.requests.find(({ method }) => method === "thread/fork");
    if (!isJsonObject(parentStart?.params) || !isJsonObject(fork?.params)) {
      throw new Error("Expected real parent startup and side fork requests");
    }
    expect(fork.params.developerInstructions).toBe(parentStart.params.developerInstructions);
    expect(fork.params.threadId).toBe(binding?.threadId);
    expect(harness.client.getCloseError()).toBeUndefined();
  } finally {
    await harness.completeTurn({ threadId: binding?.threadId ?? "thread-1", turnId: "turn-1" });
    await parent;
    closeParentHost();
    host.closeHost();
    host.closeAdmission();
  }
});
