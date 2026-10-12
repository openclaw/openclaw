import path from "node:path";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { itemNotification } from "./protocol.test-helpers.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  createStartedThreadHarness,
  fastWait,
  runCodexAppServerAttempt,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
} from "./run-attempt-test-harness.js";
import { activeRunRegistrationMocks } from "./run-attempt.steering.test-helpers.js";
import {
  createSteeringParams,
  waitAndQueueActiveRunMessage,
} from "./run-attempt.steering.test-support.js";

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const { createSteeringRuntimeMock } = await import("./run-attempt.steering.test-helpers.js");
  return createSteeringRuntimeMock(
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>(),
  );
});

setupRunAttemptTestHooks();

describe("runCodexAppServerAttempt question refresh", () => {
  beforeEach(() => {
    // Keep cold fixture setup from expiring the turn before its question can be published.
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  });

  it.each([
    { name: "gateway-backed then refresh", isSecret: false, stagedSource: false },
    { name: "secret then refresh", isSecret: true, stagedSource: false },
    { name: "staged secret then refresh", isSecret: true, stagedSource: true },
  ])("routes $name user prompts without consuming internal steering", async (scenario) => {
    const { isSecret, stagedSource } = scenario;
    activeRunRegistrationMocks.questionWaiters.clear();
    const turnStarted = createDeferred<void>();
    const { request, notify, handleServerRequest } = createStartedThreadHarness(async (method) => {
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      return undefined;
    });

    const params = createSteeringParams();
    let pendingRefresh = false;
    params.runtimePlan = createCodexRuntimePlanFixture();
    setCodexTestModelSupportsTools(params, true);
    const reload = createRuntimeDynamicTool("reload_runtime");
    reload.execute = vi.fn(async () => {
      pendingRefresh = true;
      return { content: [{ type: "text" as const, text: "generation changed" }], details: {} };
    });
    setCodexTestToolFactory(params, () => [reload]);
    params.pluginRuntimeRefreshPending = () => pendingRefresh;
    if (!params.sessionKey) {
      throw new Error("Expected the fixture's managed session key");
    }
    const target = {
      agentId: "main",
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      storePath: path.join(tempDir, "question-refresh.sqlite"),
    };
    await upsertSessionEntry({
      ...target,
      entry: { sessionId: params.sessionId, updatedAt: 1 },
    });
    params.sessionTarget = target;
    const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
    const sourceRecorder = createRecorder({
      input: { text: "2", idempotencyKey: `${params.runId}:question-answer` },
      target: { ...target, sessionEntry: undefined },
    });
    params.onBlockReply = vi.fn();
    const onRunProgress = vi.fn<NonNullable<typeof params.onRunProgress>>((event) => {
      // Host progress fires after the active turn's input bridge is installed.
      if (event.reason === "turn:start") {
        turnStarted.resolve();
      }
    });
    params.onRunProgress = onRunProgress;
    const closeHost = await bindProductionHarnessHostCapabilitiesForTest(params);
    const run = runCodexAppServerAttempt(params);
    await turnStarted.promise;
    const response = handleServerRequest({
      id: "request-input-1",
      method: "item/tool/requestUserInput",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "ask-1",
        isBlocking: true,
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret,
            options: [
              { label: "Fast", description: "Use less reasoning" },
              { label: "Deep", description: "Use more reasoning" },
            ],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1), fastWait);
    await waitAndQueueActiveRunMessage(params.sessionId, "tool progress", { debounceMs: 0 });
    await vi.waitFor(
      () => expect(request.mock.calls.map(([method]) => method)).toContain("turn/steer"),
      fastWait,
    );
    const sourceSteer = request.mock.calls.findLast(([method]) => method === "turn/steer");
    const sourceMessageId = (sourceSteer?.[1] as { clientUserMessageId?: string } | undefined)
      ?.clientUserMessageId;
    if (!sourceMessageId) {
      throw new Error("source turn/steer clientUserMessageId missing");
    }
    await notify(
      itemNotification("item/completed", {
        id: "source-message",
        type: "userMessage",
        clientId: sourceMessageId,
      }),
    );
    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason === "request:item/tool/requestUserInput:response",
      ),
    ).toBe(false);
    if (stagedSource) {
      if (!sourceRecorder.stageApproved || !params.runId) {
        throw new Error("Expected the fixture's source recorder and run identity");
      }
      expect(
        await sourceRecorder.stageApproved({ runId: params.runId, assertCurrent: () => {} }),
      ).toBe(true);
    }
    const onQuestionAccepted = vi.fn();
    await waitAndQueueActiveRunMessage(params.sessionId, "2", {
      isInboundUserMessage: true,
      onQueueAccepted: onQuestionAccepted,
      toolAuthorityFingerprint: params.toolAuthorityFingerprint,
      userTurnTranscriptRecorder: sourceRecorder,
    });
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    expect(onRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "request:item/tool/requestUserInput:response" }),
    );
    expect(onQuestionAccepted).toHaveBeenCalledWith(true);
    expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);

    // Native request_user_input is exclusive: finish its answer before the next tool call.
    await handleServerRequest({
      id: "reload-after-question",
      method: "item/tool/call",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "reload-after-question",
        namespace: null,
        tool: "reload_runtime",
        arguments: {},
      },
    });
    expect(pendingRefresh).toBe(true);
    const result = await run;
    closeHost();
    expect(result.terminal.kind).toBe("ok");
    expect(sourceRecorder.hasPersisted()).toBe(!isSecret || stagedSource);
    const carried = result.pluginRuntimeRefreshMessages ?? [];
    const questionCalls = carried.flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter((item) => item.type === "toolCall" && item.id === "ask-1")
        : [],
    );
    const questionResults = carried.filter(
      (message) => message.role === "toolResult" && message.toolCallId === "ask-1",
    );
    if (isSecret) {
      expect(questionCalls).toEqual([]);
      expect(questionResults).toEqual([]);
      expect(JSON.stringify(carried)).not.toContain(`${params.runId}:question-answer`);
    } else {
      expect(questionCalls).toHaveLength(1);
      expect(questionCalls[0]).toMatchObject({
        name: "request_user_input",
        arguments: {
          questions: [
            expect.objectContaining({ id: "mode", question: "Pick a mode", isSecret: false }),
          ],
        },
      });
      expect(questionResults).toHaveLength(1);
      expect(questionResults[0]).toMatchObject({
        toolName: "request_user_input",
        isError: false,
      });
      expect(JSON.stringify(questionResults)).toContain("Deep");
      const context = await projectContextEngineAssemblyForCodex({
        assembledMessages: carried,
        prompt: "Continue with updated tools",
        toolPayloadMode: "preserve",
      });
      expect(context.promptText).toContain("Pick a mode");
      expect(context.promptText).toContain("Deep");
    }
  });
});
