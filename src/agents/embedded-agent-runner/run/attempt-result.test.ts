import {
  AssistantMessageEventStream,
  type Message,
  type Model,
  type ToolCall,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { runAgentLoop } from "../../../plugin-sdk/agent-core.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import type { Deferred } from "../../../shared/deferred.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { getCoreTtsAttemptResultMediaUrls } from "../../tools/tts-tool-result-provenance.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import { completeEmbeddedAttemptResult, createAttemptCarryover } from "./attempt-result.js";
import { resolveSettledToolTerminalContinuationInstruction } from "./incomplete-turn-recovery.js";
import { normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

const TEST_OPERATIONAL_RUN_INSTANCE = { runId: "run-1" };

function createResultFixture(params?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  currentAttemptCompletedAssistant?: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  hasSuccessfulModelResponse?: boolean;
  replyOptional?: boolean;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder;
  messagesSnapshot?: EmbeddedRunAttemptResult["messagesSnapshot"];
  successfulNestedToolNames?: string[];
  latestMcpAppChannelView?: { viewId: string };
  clientToolCallSlots?: Array<{
    toolCallId: string;
    name: string;
    params?: Record<string, unknown>;
    completed: boolean;
  }>;
  pendingToolMediaReply?: { mediaUrls?: string[]; audioAsVoice?: boolean };
  toolAutoDeliveryMediaUrls?: string[];
  messagingToolSentMediaUrls?: string[];
  didSendViaMessagingTool?: boolean;
  yieldDetected?: boolean;
  yieldAcknowledgment?: string;
  yieldMessageWaitRegistered?: boolean;
  assistantTexts?: readonly string[];
  toolMetas?: Array<{
    toolName: string;
    toolCallId?: string;
    meta?: string;
    replaySafe?: boolean;
    isError?: boolean;
    terminate?: boolean;
    asyncStarted?: boolean;
    asyncTaskRunId?: string;
    asyncTaskId?: string;
  }>;
}) {
  const state: Parameters<typeof completeEmbeddedAttemptResult>[0]["state"] = {
    beforeAgentRunBlockedBy: undefined,
    terminal: params?.terminal ?? { kind: "ok" },
    trajectoryEndRecorded: false,
  };
  const settled: Parameters<typeof completeEmbeddedAttemptResult>[1] = {
    promptError: null,
    promptErrorSource: null,
    timedOutDuringCompaction: false,
    compactionOccurredThisAttempt: false,
    sessionIdUsed: "session-1",
    messagesSnapshot: params?.messagesSnapshot ?? [],
    lastAssistant: undefined,
    currentAttemptAssistant: undefined,
    currentAttemptCompletedAssistant: params?.currentAttemptCompletedAssistant,
    successfulNestedToolNames: params?.successfulNestedToolNames ?? [],
    attemptUsage: undefined,
    lastCallUsage: undefined,
    promptCache: undefined,
  };
  const prompt: Parameters<typeof completeEmbeddedAttemptResult>[2] = {
    preflightRecovery: undefined,
    contextBudgetStatus: undefined,
    yieldAborted: false,
    sessionIdUsed: settled.sessionIdUsed,
    sessionFileUsed: undefined,
    messagesSnapshot: settled.messagesSnapshot,
  };
  const subscription = {
    assistantTexts: [...(params?.assistantTexts ?? [])],
    didSendDeterministicApprovalPrompt: () => false,
    didSendViaMessagingTool: () => params?.didSendViaMessagingTool ?? false,
    getAcceptedSessionSpawns: () => [],
    getAssistantTurnCount: () => 0,
    getCompactionCount: () => 0,
    getItemLifecycle: (): EmbeddedRunAttemptResult["itemLifecycle"] => ({
      startedCount: 0,
      completedCount: 0,
      activeCount: 0,
    }),
    getLastAssistantTextMessageIndex: () => undefined,
    getLastCompactionTokensAfter: () => undefined,
    getLastToolError: () => undefined,
    getLatestMcpAppChannelView: () => params?.latestMcpAppChannelView,
    getLatestMcpConnectAction: () => undefined,
    getMessagingToolSentMediaUrls: () => params?.messagingToolSentMediaUrls ?? [],
    getMessagingToolSentTargets: () => [],
    getMessagingToolSentTexts: () => [],
    getMessagingToolSourceReplyPayloads: () => [],
    getSourceReplyDelivered: () => undefined,
    getSourceReplyDeliveryState: () => undefined,
    endsWithSourceProgress: () => false,
    getPendingToolMediaReply: () => params?.pendingToolMediaReply,
    getToolAutoDeliveryMediaUrls: () => params?.toolAutoDeliveryMediaUrls ?? [],
    getReplayState: () => ({ replayInvalid: false, hadPotentialSideEffects: false }),
    getSuccessfulCronAdds: () => 0,
    getVisibleBlockReplyCount: () => 0,
    hasToolMediaBlockReply: () => false,
    hasSuccessfulModelResponse: () => params?.hasSuccessfulModelResponse ?? false,
    setTerminalLifecycleMeta: () => {},
    toolMetas: params?.toolMetas ?? [],
  };
  const hookRunner = createHookRunner({ hooks: [], typedHooks: [], plugins: [] });
  const input = {
    attempt: {
      runId: "run-1",
      admittedRunContext: { operationalRunInstance: TEST_OPERATIONAL_RUN_INSTANCE },
      sessionId: "session-1",
      provider: "test",
      modelId: "model",
      model: { api: "openai-responses" },
      trigger: "user",
      allowEmptyAssistantReplyAsSilent: params?.replyOptional,
      terminalReplyExpectation: params?.replyOptional ? "optional" : undefined,
    },
    state,
    diagnostics: { diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } },
    setup: { sessionAgentId: "main" },
    lifecycle: {
      readYieldState: () => ({
        yieldDetected: params?.yieldDetected ?? false,
        yieldAcknowledgment: params?.yieldAcknowledgment,
        yieldMessageWaitRegistered: params?.yieldMessageWaitRegistered,
      }),
    },
    prepared: {
      bootstrap: { bootstrapPromptWarning: {} },
      systemPrompt: { systemPromptReport: undefined },
      sessionRuntime: {
        agentSession: {
          clientToolCallSlots: params?.clientToolCallSlots ?? [],
          hasDeliveredSourceReply: () => false,
          hookRunner,
        },
        state: { promptCache: undefined },
        cacheTrace: null,
        trajectoryRecorder: params?.trajectoryRecorder,
        transport: { streamStrategy: "default" },
      },
    },
    preparedStreamRuntime: {
      stream: { subscription },
      cache: {},
    },
  };
  return { input, state, settled, prompt, hookRunner };
}

function completeResult(params?: Parameters<typeof createResultFixture>[0]) {
  const { input, settled, prompt } = createResultFixture(params);
  return completeEmbeddedAttemptResult(input as never, settled, prompt);
}

function settledToolMessages(): EmbeddedRunAttemptResult["messagesSnapshot"] {
  return [
    {
      role: "toolResult",
      toolCallId: "call-read",
      toolName: "read",
      isError: false,
      timestamp: 1,
      content: [{ type: "text", text: "file contents" }],
    },
  ];
}

describe("attempt result projection", () => {
  it("keeps the settled result snapshot when an output hook replaces live state", () => {
    const assistant = makeAssistantMessageFixture({ content: [{ type: "text", text: "settled" }] });
    const fixture = createResultFixture({
      currentAttemptCompletedAssistant: assistant,
      hasSuccessfulModelResponse: true,
      successfulNestedToolNames: ["read", "memory_search"],
      latestMcpAppChannelView: { viewId: "view-latest" },
    });
    fixture.settled.lastAssistant = assistant;
    fixture.prompt.finalPromptText = "settled prompt";
    const messages = fixture.prompt.messagesSnapshot;
    vi.spyOn(fixture.hookRunner, "hasHooks").mockReturnValue(true);
    const output = vi.spyOn(fixture.hookRunner, "runLlmOutput").mockImplementationOnce(async () => {
      fixture.state.terminal = { kind: "failed", source: "prompt", error: new Error("later") };
      fixture.settled.lastAssistant = undefined;
      fixture.settled.currentAttemptCompletedAssistant = undefined;
      fixture.input.preparedStreamRuntime.stream.subscription.hasSuccessfulModelResponse = () =>
        false;
      fixture.settled.attemptUsage = { input: 100, output: 200 };
      fixture.prompt.finalPromptText = "later prompt";
      fixture.prompt.messagesSnapshot = [{ role: "user", content: "later", timestamp: 2 }];
      fixture.input.lifecycle.readYieldState = () => ({
        yieldDetected: true,
        yieldAcknowledgment: "later yield",
        yieldMessageWaitRegistered: true,
      });
    });

    const result = completeEmbeddedAttemptResult(
      fixture.input as never,
      fixture.settled,
      fixture.prompt,
    );

    expect(output).toHaveBeenCalledOnce();
    expect(fixture.state.terminal.kind).toBe("failed");
    expect(result.terminal).toEqual({ kind: "ok" });
    expect(result.lastAssistant).toBe(assistant);
    expect(result.currentAttemptCompletedAssistant).toBe(assistant);
    expect(result.hasSuccessfulModelResponse).toBe(true);
    expect(result.successfulNestedToolNames).toEqual(["read", "memory_search"]);
    expect(result.latestMcpAppChannelView).toEqual({ viewId: "view-latest" });
    expect(result.messagesSnapshot).toBe(messages);
    expect(result.finalPromptText).toBe("settled prompt");
    expect(result.attemptUsage).toBeUndefined();
    expect(result).toHaveProperty("yieldDetected", undefined);
    expect(result).toHaveProperty("yieldAcknowledgment", undefined);
    expect(result).toHaveProperty("yieldMessageWaitRegistered", undefined);
    expect(result).not.toHaveProperty("beforeAgentFinalizeRevisionReason");
  });

  it.each([false, true])(
    "preserves attempt progress=%s after a later failure without inferring progress from history",
    (hasSuccessfulModelResponse) => {
      const result = completeResult({
        hasSuccessfulModelResponse,
        terminal: { kind: "failed", source: "prompt", error: new Error("request timed out") },
        messagesSnapshot: [
          makeAssistantMessageFixture({ stopReason: "stop", errorMessage: undefined }),
        ],
        currentAttemptCompletedAssistant: makeAssistantMessageFixture(),
      });

      expect(result.hasSuccessfulModelResponse).toBe(hasSuccessfulModelResponse);
    },
  );

  it("keeps current tool replay evidence separate from cumulative replay state", () => {
    const result = completeResult({ toolMetas: [{ toolName: "cron", replaySafe: false }] });

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(result.currentAttemptReplayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it.each([
    {
      label: "an uncorroborated messaging flag",
      assistant: undefined,
      didSendViaMessagingTool: true,
      expectedStatus: "error",
      terminalError: "non_deliverable_terminal_turn",
    },
    {
      label: "a completed refusal",
      assistant: makeAssistantMessageFixture({
        content: [],
        diagnostics: [{ type: "provider_refusal", timestamp: 1, details: { category: "cyber" } }],
      }),
      expectedStatus: "error",
      terminalError: undefined,
    },
    {
      label: "a completed empty length stop",
      assistant: makeAssistantMessageFixture({
        content: [],
        stopReason: "length",
        errorMessage: undefined,
      }),
      expectedStatus: "error",
      terminalError: "non_deliverable_terminal_turn",
    },
    {
      label: "an actually empty optional turn",
      assistant: undefined,
      expectedStatus: "success",
      terminalError: undefined,
    },
  ])(
    "records $label after transcript projection",
    ({ assistant, didSendViaMessagingTool, expectedStatus, terminalError }) => {
      const recordEvent = vi.fn<EmbeddedRunAttemptTrajectoryRecorder["recordEvent"]>();
      const result = completeResult({
        currentAttemptCompletedAssistant: assistant,
        replyOptional: !didSendViaMessagingTool,
        didSendViaMessagingTool,
        trajectoryRecorder: { recordEvent, flush: async () => {} },
      });

      expect(result.currentAttemptAssistant).toBeUndefined();
      expect(result.currentAttemptCompletedAssistant).toEqual(assistant);
      if (didSendViaMessagingTool) {
        expect(result.didSendViaMessagingTool).toBe(true);
      }
      expect(recordEvent).toHaveBeenCalledWith(
        "session.ended",
        expect.objectContaining({ status: expectedStatus, terminalError }),
      );
    },
  );

  type ResultInput = NonNullable<Parameters<typeof createResultFixture>[0]>;
  const socketReset = Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
  const failed = (
    error: Error,
    source: "prompt" | "precheck" | "compaction" | "hook:before_agent_run" = "prompt",
    timeoutObservation?: "compaction" | "tool_execution",
  ): ResultInput => ({ terminal: { kind: "failed", source, error, timeoutObservation } });
  const assistantFailure = (errorMessage: string, errorCode?: string): ResultInput => ({
    currentAttemptCompletedAssistant: makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage,
      ...(errorCode ? { errorCode } : {}),
    }),
  });
  const truncated = failed(new Error("Stream ended without finish_reason"));
  it.each<[string, ResultInput, boolean]>([
    ["provider socket reset", failed(socketReset), true],
    [
      "nested socket failure",
      failed(
        new Error("provider request failed", {
          cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }),
        }),
      ),
      true,
    ],
    [
      "authentication failure",
      failed(Object.assign(new Error("401 Unauthorized"), { status: 401 })),
      false,
    ],
    [
      "quota exhaustion",
      failed(Object.assign(new Error("429 insufficient_quota"), { status: 429 })),
      false,
    ],
    ["policy denial", failed(new Error("content policy violation")), false],
    [
      "security denial",
      failed(Object.assign(new Error("403 Forbidden: security policy denied"), { status: 403 })),
      false,
    ],
    ["malformed response", failed(new SyntaxError("Unexpected token in JSON response")), false],
    ["truncated stream", truncated, true],
    ["precheck socket failure", failed(socketReset, "precheck"), false],
    ["compaction socket failure", failed(socketReset, "compaction"), false],
    ["agent hook socket failure", failed(socketReset, "hook:before_agent_run"), false],
    [
      "assistant WebSocket error",
      assistantFailure("WebSocket error", "ERR_WEBSOCKET_TRANSPORT"),
      true,
    ],
    [
      "assistant coded socket failure",
      assistantFailure("provider request failed", "ECONNRESET"),
      true,
    ],
    ["assistant authentication failure", assistantFailure("invalid API key"), false],
    ["assistant truncated stream", assistantFailure("Stream ended without finish_reason"), true],
    [
      "only pre-tool commentary",
      {
        ...truncated,
        assistantTexts: ["Checking the post-reboot state."],
        messagesSnapshot: [
          makeAssistantMessageFixture({
            stopReason: "toolUse",
            errorMessage: undefined,
            timestamp: 1,
            content: [
              { type: "text", text: "Checking the post-reboot state." },
              { type: "toolCall", id: "call-read", name: "read", arguments: {} },
            ],
          }),
          ...settledToolMessages(),
          makeAssistantMessageFixture({
            stopReason: "error",
            errorMessage: "Stream ended without finish_reason",
            timestamp: 3,
            content: [],
          }),
        ],
      },
      true,
    ],
    ["unattributed visible text", { ...truncated, assistantTexts: ["here is the answer"] }, false],
    [
      "post-tool authored text",
      {
        ...truncated,
        assistantTexts: ["here is the answer"],
        messagesSnapshot: [
          ...settledToolMessages(),
          makeAssistantMessageFixture({
            stopReason: "stop",
            errorMessage: undefined,
            timestamp: 2,
            content: [{ type: "text", text: "here is the answer" }],
          }),
        ],
      },
      false,
    ],
    ["compaction failure observation", failed(socketReset, "prompt", "compaction"), false],
    ["tool execution failure observation", failed(socketReset, "prompt", "tool_execution"), false],
    ...(["compaction", "tool_execution"] as const).map((phase): [string, ResultInput, boolean] => [
      `assistant ${phase} timeout`,
      {
        ...assistantFailure("WebSocket error", "ERR_WEBSOCKET_TRANSPORT"),
        terminal: { kind: "timeout", phase, source: "observation" },
      },
      false,
    ]),
  ])("limits settled-turn recovery after %s", (_name, params, expected) => {
    const result = completeResult({ messagesSnapshot: settledToolMessages(), ...params });
    if (expected) {
      expect(Boolean(result.settledTurnFinalizationContext)).toBe(true);
    } else {
      expect(result.settledTurnFinalizationContext).toBeUndefined();
    }
  });

  it.each([true, false, undefined])(
    "carries yield acknowledgment and owner-recorded message wait (%s) separately from private context",
    (yieldMessageWaitRegistered) => {
      expect(
        completeResult({
          yieldDetected: true,
          yieldAcknowledgment: "Waiting for a continuation.",
          yieldMessageWaitRegistered,
        }),
      ).toMatchObject({
        yieldDetected: true,
        yieldAcknowledgment: "Waiting for a continuation.",
        yieldMessageWaitRegistered,
      });
    },
  );

  it("defaults missing replay metadata to replay-unsafe", () => {
    const attempt = completeResult();
    delete (attempt as Partial<typeof attempt>).replayMetadata;

    expect(normalizeEmbeddedRunAttemptResult(attempt as never).replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("carries the newest MCP presentation state across retry attempts", () => {
    const carryover = createAttemptCarryover();
    const first = {
      latestMcpAppChannelView: { viewId: "view-first" },
      latestMcpConnectAction: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/first",
      },
    };
    const retry: Parameters<typeof carryover.apply>[0] = {};
    const latest = {
      latestMcpAppChannelView: { viewId: "view-latest" },
      latestMcpConnectAction: {
        serverName: "calendar",
        authorizationUrl: "https://auth.example/latest",
      },
    };

    carryover.apply(first);
    carryover.apply(retry);
    carryover.apply(latest);

    expect(retry).toEqual(first);
    expect(latest.latestMcpAppChannelView.viewId).toBe("view-latest");
    expect(latest.latestMcpConnectAction.authorizationUrl).toBe("https://auth.example/latest");
  });

  it("keeps completed client tool calls in reserved source order", () => {
    expect(
      completeResult({
        clientToolCallSlots: [
          { toolCallId: "first", name: "search", params: { query: "one" }, completed: true },
          { toolCallId: "second", name: "search", completed: false },
          { toolCallId: "third", name: "fetch", params: { id: 3 }, completed: true },
        ],
      }).clientToolCalls,
    ).toEqual([
      { name: "search", params: { query: "one" } },
      { name: "fetch", params: { id: 3 } },
    ]);
  });

  it("filters invalid tool metadata and preserves terminal flags", () => {
    expect(
      completeResult({
        toolMetas: [
          { toolName: "", replaySafe: true },
          { toolName: "read", isError: false },
          {
            toolName: "exec",
            toolCallId: "tool-current",
            meta: "done",
            replaySafe: true,
            isError: true,
            terminate: true,
            asyncStarted: true,
            asyncTaskRunId: "run-1",
            asyncTaskId: "task-1",
          },
        ],
      }).toolMetas,
    ).toEqual([
      {
        toolName: "read",
        meta: undefined,
        replaySafe: false,
        isError: false,
      },
      {
        toolName: "exec",
        toolCallId: "tool-current",
        meta: "done",
        replaySafe: true,
        isError: true,
        terminate: true,
        asyncStarted: true,
        asyncTaskRunId: "run-1",
        asyncTaskId: "task-1",
      },
    ]);
  });

  it("projects pending media and voice fields", () => {
    expect(completeResult().toolMediaUrls).toBeUndefined();
    expect(completeResult({ pendingToolMediaReply: { mediaUrls: [" "] } }).toolMediaUrls).toEqual([
      " ",
    ]);
    expect(
      completeResult({ pendingToolMediaReply: { mediaUrls: ["file:///tmp/result.png"] } })
        .toolMediaUrls,
    ).toEqual(["file:///tmp/result.png"]);
    expect(completeResult({ pendingToolMediaReply: { audioAsVoice: true } }).toolAudioAsVoice).toBe(
      true,
    );
    const autoDeliveryResult = completeResult({
      pendingToolMediaReply: { mediaUrls: ["/tmp/reply.opus"] },
      toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
    });
    expect(
      getCoreTtsAttemptResultMediaUrls(
        autoDeliveryResult,
        autoDeliveryResult.toolMediaUrls,
        TEST_OPERATIONAL_RUN_INSTANCE,
      ),
    ).toEqual(["/tmp/reply.opus"]);
    const alreadySentResult = completeResult({
      pendingToolMediaReply: { mediaUrls: ["/tmp/reply.opus"] },
      toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
      messagingToolSentMediaUrls: ["/tmp/reply.opus"],
    });
    expect(
      getCoreTtsAttemptResultMediaUrls(
        alreadySentResult,
        alreadySentResult.toolMediaUrls,
        TEST_OPERATIONAL_RUN_INSTANCE,
      ),
    ).toEqual([]);
  });
});

describe("trailing source progress at runtime settlement", () => {
  const testModel: Model = {
    id: "settle-model",
    name: "Settle Model",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 8_000,
  };
  // Native-async calls run while the provider streams; each settles before the next fragment.
  type ModelCall = { tools?: Array<"progress" | "read">; async?: true };

  async function settleRealLoop(calls: ModelCall[]) {
    const sessionManager = {};
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-1",
      sourceReplyDeliveryMode: "message_tool_only",
      sessionExtras: { sessionManager } as never,
    });
    const messages: AgentMessage[] = [];
    let callIndex = 0;
    const tool = (name: string, execute: (toolCallId: string) => void) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (toolCallId: string) => {
        execute(toolCallId);
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    });
    const toolSettled = new Map<string, Deferred>();
    const settledFor = (toolCallId: string) => {
      const settled = toolSettled.get(toolCallId) ?? createDeferred();
      toolSettled.set(toolCallId, settled);
      return settled;
    };
    await runAgentLoop(
      [{ role: "user", content: "Run the report.", timestamp: 0 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          tool("message", (toolCallId) =>
            recordEmbeddedToolReceipt(
              sessionManager,
              toolCallId,
              {
                messageDelivery: {
                  status: "settled",
                  partialDelivery: false,
                  createdThreadIds: [],
                  sourceReplyDelivered: true,
                },
              },
              true,
            ),
          ),
          tool("read", () => {}),
        ],
      },
      {
        model: testModel,
        convertToLlm: (history) =>
          history.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
      },
      async (event) => {
        emit(event);
        if (event.type === "message_end") {
          messages.push(event.message);
        }
        if (event.type === "tool_execution_end") {
          await subscription.waitForPendingEvents();
          settledFor(event.toolCallId).resolve();
        }
        if (event.type === "agent_end") {
          await subscription.waitForPendingEvents();
        }
      },
      undefined,
      () => {
        const call = calls[callIndex++] ?? {};
        const toolCalls: ToolCall[] = (call.tools ?? []).map((name, index) => ({
          type: "toolCall",
          id: `${name}-${callIndex}-${index}`,
          name: name === "progress" ? "message" : "read",
          arguments:
            name === "progress"
              ? {
                  action: "send",
                  final: false,
                  target: "channel:source",
                  message: "Started the run, I will report back.",
                }
              : {},
          async: call.async,
        }));
        const message = makeAssistantMessageFixture({
          api: testModel.api,
          provider: testModel.provider,
          model: testModel.id,
          content: [...toolCalls, { type: "text", text: "" }],
          stopReason: toolCalls.length > 0 && !call.async ? "toolUse" : "stop",
          errorMessage: undefined,
        });
        const stream = new AssistantMessageEventStream();
        void (async () => {
          stream.push({ type: "start", partial: { ...message, content: [] } });
          for (const [index, toolCall] of toolCalls.entries()) {
            stream.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall,
              partial: { ...message, content: toolCalls.slice(0, index + 1) },
            });
            if (call.async) {
              await settledFor(toolCall.id).promise;
            }
          }
          stream.push({ type: "done", reason: "stop", message });
          stream.end();
        })();
        return stream;
      },
    );
    expect(callIndex).toBe(calls.length);
    const fixture = createResultFixture();
    fixture.input.preparedStreamRuntime.stream.subscription = subscription as never;
    const terminalAssistant = messages.findLast((message) => message.role === "assistant");
    fixture.settled.currentAttemptAssistant = terminalAssistant as never;
    fixture.settled.currentAttemptCompletedAssistant = terminalAssistant as never;
    fixture.settled.messagesSnapshot = messages;
    fixture.prompt.messagesSnapshot = messages;
    const result = completeEmbeddedAttemptResult(
      fixture.input as never,
      fixture.settled,
      fixture.prompt,
    );
    subscription.unsubscribe();
    return {
      result,
      finalizerInstruction: resolveSettledToolTerminalContinuationInstruction({
        executionContract: "strict-agentic",
        allowEmptyStopContinuation: true,
        payloadCount: 0,
        aborted: false,
        timedOut: false,
        attempt: result,
      }),
    };
  }

  it.each<[string, ModelCall[], boolean]>([
    ["last tool batch", [{ tools: ["progress"] }, {}], true],
    ["later work", [{ tools: ["progress"], async: true }, { tools: ["read"] }, {}], false],
    ["shared provider response", [{ tools: ["read", "progress"], async: true }, {}], false],
  ])("settles source progress with %s", async (_name, calls, delivered) => {
    const { result, finalizerInstruction } = await settleRealLoop(calls);
    expect(result.sourceReplyDeliveryState).toBe(delivered ? "delivered" : "missing");
    expect(result.messagingToolSentTargets?.map((send) => send.sourceReplyFinal)).toEqual([
      delivered,
    ]);
    if (delivered) {
      expect(finalizerInstruction).toBeNull();
    } else {
      expect(finalizerInstruction).toContain("did not produce a user-visible answer");
    }
  });
});
