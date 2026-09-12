import path from "node:path";
import { claimPendingAgentQuestionAnswer } from "openclaw/plugin-sdk/agent-harness-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { loadUserTurnTranscriptRecorderFactoryForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { describe, expect, it, vi } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";
import { dynamicToolBuildState } from "./dynamic-tool-build-state.js";
import type { CodexServerNotification } from "./protocol.js";
import {
  bindProductionHarnessHostCapabilitiesForTest,
  createCodexRuntimePlanFixture,
  createRuntimeDynamicTool,
  fastWait,
  mockClientRuntimeMethods,
  runCodexAppServerAttempt,
  setCodexAppServerClientFactoryForTest,
  setCodexTestModelSupportsTools,
  setupRunAttemptTestHooks,
  tempDir,
  threadStartResult,
  turnStartResult,
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
  it.each([
    { name: "gateway-backed", isSecret: false, refresh: false, stagedSource: false },
    { name: "secret", isSecret: true, refresh: false, stagedSource: false },
    { name: "gateway-backed then refresh", isSecret: false, refresh: true, stagedSource: false },
    { name: "secret then refresh", isSecret: true, refresh: true, stagedSource: false },
    {
      name: "gateway-backed external claim then refresh",
      isSecret: false,
      refresh: true,
      stagedSource: false,
      directClaim: true,
    },
    {
      name: "UI answer then refresh",
      isSecret: false,
      refresh: true,
      stagedSource: false,
      uiAnswer: true,
    },
    { name: "staged secret then refresh", isSecret: true, refresh: true, stagedSource: true },
  ])("routes $name user prompts without consuming internal steering", async (scenario) => {
    const { isSecret, refresh, stagedSource } = scenario;
    const directClaim = "directClaim" in scenario && scenario.directClaim;
    const uiAnswer = "uiAnswer" in scenario && scenario.uiAnswer;
    activeRunRegistrationMocks.questionWaiters.clear();
    const turnStarted = createDeferred<void>();
    let notify: (notification: CodexServerNotification) => Promise<void> = async () => undefined;
    let handleRequest:
      | ((request: { id: string; method: string; params?: unknown }) => Promise<unknown>)
      | undefined;
    const request = vi.fn(async (method: string, _params?: unknown) => {
      if (method === "config/read") {
        return { config: {}, origins: {}, layers: [] };
      }
      if (method === "configRequirements/read") {
        return { requirements: null };
      }
      if (method === "thread/start") {
        return threadStartResult();
      }
      if (method === "turn/start") {
        turnStarted.resolve();
        return turnStartResult();
      }
      if (method === "turn/interrupt") {
        await notify({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "interrupted" } },
        });
      }
      if (method === "thread/backgroundTerminals/list") {
        return { data: [], nextCursor: null };
      }
      if (method === "thread/unsubscribe") {
        return { status: "unsubscribed" };
      }
      return {};
    });
    setCodexAppServerClientFactoryForTest(
      async () =>
        ({
          ...mockClientRuntimeMethods(),
          request,
          addNotificationHandler: (handler: typeof notify) => {
            notify = handler;
            return () => undefined;
          },
          addRequestHandler: (
            handler: (request: {
              id: string;
              method: string;
              params?: unknown;
            }) => Promise<unknown>,
          ) => {
            handleRequest = handler;
            return () => undefined;
          },
        }) as never,
    );

    const params = createSteeringParams();
    let pendingRefresh = false;
    let sourceRecorder: typeof params.userTurnTranscriptRecorder;
    if (refresh) {
      params.runtimePlan = createCodexRuntimePlanFixture();
      setCodexTestModelSupportsTools(params, true);
      const reload = createRuntimeDynamicTool("reload_runtime");
      reload.execute = vi.fn(async () => {
        pendingRefresh = true;
        return { content: [{ type: "text" as const, text: "generation changed" }], details: {} };
      });
      dynamicToolBuildState.openClawCodingToolsFactory = () => [reload];
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
      if (!uiAnswer) {
        const createRecorder = await loadUserTurnTranscriptRecorderFactoryForTest();
        sourceRecorder = createRecorder({
          input: { text: "2", idempotencyKey: `${params.runId}:question-answer` },
          target: { ...target, sessionEntry: undefined },
        });
      }
    }
    params.onBlockReply = vi.fn();
    const onRunProgress = vi.fn();
    params.onRunProgress = onRunProgress;
    const closeHost = refresh
      ? await bindProductionHarnessHostCapabilitiesForTest(params)
      : undefined;
    const run = runCodexAppServerAttempt(params);
    await turnStarted.promise;
    await vi.waitFor(() => expect(handleRequest).toBeTypeOf("function"), fastWait);

    const response = handleRequest?.({
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
    await notify({
      method: "item/completed",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        item: { id: "source-message", type: "userMessage", clientId: sourceMessageId },
      },
    });
    expect(
      onRunProgress.mock.calls.some(
        ([event]) =>
          (event as { reason?: string }).reason === "request:item/tool/requestUserInput:response",
      ),
    ).toBe(false);
    if (stagedSource) {
      if (!sourceRecorder?.stageApproved || !params.runId) {
        throw new Error("Expected the fixture's source recorder and run identity");
      }
      expect(
        await sourceRecorder.stageApproved({ runId: params.runId, assertCurrent: () => {} }),
      ).toBe(true);
    }
    const onQuestionAccepted = vi.fn();
    if (uiAnswer) {
      const waiters = [...activeRunRegistrationMocks.questionWaiters.values()];
      expect(waiters).toHaveLength(1);
      const [resolveAnswer] = waiters;
      if (!resolveAnswer) {
        throw new Error("Expected the current ordinary question waiter");
      }
      resolveAnswer({ status: "answered", answers: { answers: { mode: ["Deep"] } } });
    } else if (directClaim) {
      // Core reply ingress can consume the question before asking the native handle to steer.
      expect(
        await claimPendingAgentQuestionAnswer({
          sessionKey: params.sessionKey,
          text: "2",
          sourceRecorder,
          authority: { kind: "run", assertCurrent: () => {} },
        }),
      ).toBe(true);
    } else {
      await waitAndQueueActiveRunMessage(params.sessionId, "2", {
        isInboundUserMessage: true,
        onQueueAccepted: onQuestionAccepted,
        toolAuthorityFingerprint: params.toolAuthorityFingerprint,
        ...(sourceRecorder ? { userTurnTranscriptRecorder: sourceRecorder } : {}),
      });
    }
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Deep"] } },
    });
    expect(onRunProgress).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "request:item/tool/requestUserInput:response" }),
    );
    if (!directClaim && !uiAnswer) {
      expect(onQuestionAccepted).toHaveBeenCalledWith(true);
    }
    expect(request.mock.calls.filter(([method]) => method === "turn/steer")).toHaveLength(1);

    if (refresh) {
      // Native request_user_input is exclusive: finish its answer before the next tool call.
      await handleRequest?.({
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
      closeHost?.();
      expect(result.terminal.kind).toBe("ok");
      if (uiAnswer) {
        expect(sourceRecorder).toBeUndefined();
      } else {
        expect(sourceRecorder?.hasPersisted()).toBe(!isSecret || stagedSource);
      }
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
          originalHistoryMessages: [],
          prompt: "Continue with updated tools",
          toolPayloadMode: "preserve",
        });
        expect(context.promptText).toContain("Pick a mode");
        expect(context.promptText).toContain("Deep");
      }
    } else {
      await notify({
        method: "turn/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          turn: { id: "turn-1", status: "completed" },
        },
      });
      await run;
    }
  });
});
