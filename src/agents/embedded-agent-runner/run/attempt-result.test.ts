import { expectDefined } from "@openclaw/normalization-core";
import { AssistantMessageEventStream, type Message, type ToolCall } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { selectHeartbeatToolResponse } from "../../../auto-reply/heartbeat-tool-response.js";
import { getReplyPayloadMetadata } from "../../../auto-reply/reply-payload.js";
import { HEARTBEAT_TOKEN } from "../../../auto-reply/tokens.js";
import { runAgentLoop } from "../../../plugin-sdk/agent-core.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import type { Deferred } from "../../../shared/deferred.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import type { AgentMessage } from "../../runtime/index.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { getCoreTtsAttemptResultMediaUrls } from "../../tools/tts-tool-result-provenance.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import { completeEmbeddedAttemptResult, createAttemptCarryover } from "./attempt-result.js";
import { createSubscriptionMock } from "./attempt-spawn-workspace.subscription-mock.test-support.js";
import { resolveSettledToolTerminalContinuation } from "./incomplete-turn-recovery.js";
import { buildPayloads } from "./payloads.test-helpers.js";
import { normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

const TEST_OPERATIONAL_RUN_INSTANCE = { runId: "run-1" };

function createResultFixture(params?: {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  currentAttemptCompletedAssistant?: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  hasSuccessfulModelResponse?: boolean;
  heartbeatToolResponse?: EmbeddedRunAttemptResult["heartbeatToolResponse"];
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
  assistantTexts?: readonly string[];
  allowedToolNames?: string[];
  toolMetas?: EmbeddedRunAttemptResult["toolMetas"];
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
    ...createSubscriptionMock(),
    answerSegments: undefined,
    assistantTexts: [...(params?.assistantTexts ?? [])],
    didSendViaMessagingTool: () => params?.didSendViaMessagingTool ?? false,
    getHeartbeatToolResponse: () => params?.heartbeatToolResponse,
    getLatestMcpAppChannelView: () => params?.latestMcpAppChannelView,
    getMessagingToolSentMediaUrls: () => params?.messagingToolSentMediaUrls ?? [],
    getPendingToolMediaReply: () => params?.pendingToolMediaReply,
    getToolAutoDeliveryMediaUrls: () => params?.toolAutoDeliveryMediaUrls ?? [],
    hasSuccessfulModelResponse: () => params?.hasSuccessfulModelResponse ?? false,
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
      readYieldState: () => ({ yieldDetected: false }),
    },
    prepared: {
      toolCatalog: {
        toolSearchRunPlan: { liveAllowedToolNames: new Set(params?.allowedToolNames) },
      },
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

function textAssistant(
  text: string,
  overrides: Parameters<typeof makeAssistantMessageFixture>[0] = {},
) {
  return makeAssistantMessageFixture({
    stopReason: "stop",
    content: [{ type: "text", text }],
    ...overrides,
  });
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
  it.each<{ parts: string[]; text: string; signedIndex?: number }>([
    { parts: ["First part.", "Second part."], text: "First part.\nSecond part." },
    { parts: ["NO_RE", "PLY\nFirst part.", "Second part."], text: "First part.\nSecond part." },
    { parts: ["First part.", "Second part.\n\nNO_REPLY"], text: "First part.\nSecond part." },
    { parts: ["First part.\n", "NO_", "REPLY"], text: "First part." },
    {
      parts: ["Legacy context.", "Signed answer."],
      signedIndex: 1,
      text: "Legacy context.\nSigned answer.",
    },
    {
      parts: ["Legacy context.", "Signed answer.\n\nNO_REPLY"],
      signedIndex: 1,
      text: "Signed answer.",
    },
  ])("preserves native answer boundaries for $parts", ({ parts, text, signedIndex }) => {
    const assistant = makeAssistantMessageFixture({
      stopReason: "stop",
      content: parts.map((part, index) => ({
        type: "text",
        text: part,
        ...(index === signedIndex
          ? { textSignature: JSON.stringify({ v: 1, id: "item_unphased" }) }
          : {}),
      })),
    });
    const result = completeResult({
      currentAttemptCompletedAssistant: assistant,
      assistantTexts: parts,
      hasSuccessfulModelResponse: true,
    });
    expect(result.preparedTerminalReply).toEqual({
      text,
      terminalReply: { disposition: "visible", text },
    });
    expect(
      buildPayloads({
        ...result,
        currentAssistant: assistant,
        lastAssistant: assistant,
      }),
    ).toMatchObject([{ text }]);
  });

  it.each([
    { name: "Write", allowedToolNames: ["write"], expected: true },
    { name: "functions.write", allowedToolNames: ["write"], expected: true },
    { name: "WRITE", allowedToolNames: ["Write", "wriTE"], expected: undefined },
  ])("uses native callable-name matching for $name", ({ name, allowedToolNames, expected }) => {
    const assistant = textAssistant(JSON.stringify({ name, arguments: { path: "proof.txt" } }));
    expect(
      completeResult({ currentAttemptCompletedAssistant: assistant, allowedToolNames })
        .textToolCallAttempt,
    ).toBe(expected);
  });

  it.each(
    [false, true].flatMap((nativeCall) =>
      [
        '{"name":"write","arguments":{"path":"proof.txt"}}',
        "<tool_call><function=write><parameter=path>proof.txt</parameter></function></tool_call>",
        'Action: write\nAction Input: {"path":"proof.txt"}',
        '[TOOL_CALL]{tool => "write", args => {"path":"proof.txt"}}[/TOOL_CALL]',
      ].map((text) => ({ nativeCall, text })),
    ),
  )(
    "recognizes text-only terminal calls after a read (native=$nativeCall): $text",
    ({ nativeCall, text }) => {
      const assistant = textAssistant(text);
      if (nativeCall) {
        assistant.content.push({ type: "toolCall", id: "native", name: "write", arguments: {} });
      }
      const result = completeResult({
        currentAttemptCompletedAssistant: assistant,
        allowedToolNames: ["write"],
        toolMetas: [{ toolName: "read", replaySafe: true, isError: false }],
      });
      expect(result.textToolCallAttempt).toBe(nativeCall ? undefined : true);
    },
  );

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
    expect(result.lastAssistant).toBe(assistant);
    expect(result.currentAttemptCompletedAssistant).toBe(assistant);
    expect(result.messagesSnapshot).toBe(messages);
    expect(result).toMatchObject({
      terminal: { kind: "ok" },
      hasSuccessfulModelResponse: true,
      successfulNestedToolNames: ["read", "memory_search"],
      latestMcpAppChannelView: { viewId: "view-latest" },
      finalPromptText: "settled prompt",
      attemptUsage: undefined,
      yieldDetected: undefined,
      yieldAcknowledgment: undefined,
      yieldMessageWaitRegistered: undefined,
    });
    expect(result).not.toHaveProperty("beforeAgentFinalizeRevisionReason");
  });

  it("keeps current tool replay evidence separate from cumulative replay state", () => {
    const result = completeResult({ toolMetas: [{ toolName: "cron", replaySafe: false }] });

    expect(result.replayMetadata).toEqual({ hadPotentialSideEffects: false, replaySafe: true });
    expect(result.currentAttemptReplayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  const nonDeliverable = "non_deliverable_terminal_turn";
  it.each([
    {
      label: "an uncorroborated messaging flag",
      didSendViaMessagingTool: true,
      terminalError: nonDeliverable,
    },
    {
      label: "a completed refusal",
      assistant: makeAssistantMessageFixture({
        content: [],
        diagnostics: [{ type: "provider_refusal", timestamp: 1, details: { category: "cyber" } }],
      }),
      terminalError: undefined,
    },
    {
      label: "a completed empty length stop",
      assistant: makeAssistantMessageFixture({
        content: [],
        stopReason: "length",
        errorMessage: undefined,
      }),
      terminalError: nonDeliverable,
    },
    { label: "an actually empty optional turn", terminalError: nonDeliverable },
  ])(
    "records $label after transcript projection",
    ({ assistant, didSendViaMessagingTool, terminalError }) => {
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
        expect.objectContaining({ status: "error", terminalError }),
      );
    },
  );

  type ResultInput = NonNullable<Parameters<typeof createResultFixture>[0]>;
  const failed = (error: Error): ResultInput => ({
    terminal: { kind: "failed", source: "prompt", error },
  });
  const assistantFailure = (errorMessage: string, errorCode?: string): ResultInput => ({
    currentAttemptCompletedAssistant: makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage,
      ...(errorCode ? { errorCode } : {}),
    }),
  });
  const truncated = failed(new Error("Stream ended without finish_reason"));
  it.each<[string, ResultInput, boolean]>([
    ["policy denial", failed(new Error("content policy violation")), false],
    [
      "assistant WebSocket error",
      assistantFailure("WebSocket error", "ERR_WEBSOCKET_TRANSPORT"),
      true,
    ],
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
    [
      "snapshot-only media",
      {
        ...truncated,
        messagesSnapshot: [
          ...settledToolMessages(),
          textAssistant("MEDIA:https://example.com/result.png"),
        ],
      },
      false,
    ],
    [
      "post-tool authored text",
      {
        ...truncated,
        assistantTexts: ["here is the answer"],
        messagesSnapshot: [
          ...settledToolMessages(),
          textAssistant("here is the answer", { errorMessage: undefined, timestamp: 2 }),
        ],
      },
      false,
    ],
    [
      "assistant tool_execution timeout",
      {
        ...assistantFailure("WebSocket error", "ERR_WEBSOCKET_TRANSPORT"),
        terminal: { kind: "timeout", phase: "tool_execution", source: "observation" },
      },
      false,
    ],
  ])("limits settled-turn recovery after %s", (_name, params, expected) => {
    const result = completeResult({ messagesSnapshot: settledToolMessages(), ...params });
    if (expected) {
      expect(Boolean(result.settledTurnFinalizationContext)).toBe(true);
    } else {
      expect(result.settledTurnFinalizationContext).toBeUndefined();
    }
  });

  it("defaults missing replay metadata to replay-unsafe", () => {
    const attempt = completeResult();
    delete (attempt as Partial<typeof attempt>).replayMetadata;

    expect(normalizeEmbeddedRunAttemptResult(attempt as never).replayMetadata).toEqual({
      hadPotentialSideEffects: true,
      replaySafe: false,
    });
  });

  it("carries quiet heartbeat output and private scratch across empty retries", () => {
    const carryover = createAttemptCarryover();
    const publicResponse = {
      outcome: "done" as const,
      notify: false,
      summary: "The task reached its completion condition.",
      notificationText: "The monitored task is complete.",
    };
    const scratch = "Private monitor notes: completion checked; no follow-up needed.";
    const providerFailure = {
      kind: "failed" as const,
      source: "prompt" as const,
      error: Object.assign(new Error("529 overloaded"), { status: 529 }),
    };
    const accepted = completeResult({
      heartbeatToolResponse: { ...publicResponse, scratch },
      terminal: providerFailure,
    });
    const retry = completeResult({ terminal: providerFailure });
    const completed = completeResult({ assistantTexts: ["Internal retry fallback."] });

    carryover.apply(accepted);
    carryover.apply(retry);
    carryover.apply(completed);
    const payloads = buildPayloads({
      isHeartbeatTrigger: true,
      assistantTexts: completed.assistantTexts,
      heartbeatToolResponse: completed.heartbeatToolResponse,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(HEARTBEAT_TOKEN);
    const selected = expectDefined(
      selectHeartbeatToolResponse(payloads),
      "expected the carried heartbeat response",
    );
    expect(selected.response).toEqual(publicResponse);
    expect(getReplyPayloadMetadata(selected.payload)?.heartbeatScratchProposal).toBe(scratch);
    expect(JSON.stringify(payloads)).not.toContain(scratch);
    expect(JSON.stringify(payloads)).not.toContain("Internal retry fallback.");
  });

  it("starts a fresh run without the previous heartbeat response or scratch", () => {
    const previousRun = createAttemptCarryover();
    previousRun.apply(
      completeResult({
        heartbeatToolResponse: {
          outcome: "done",
          notify: true,
          summary: "Previous task complete.",
          scratch: "Private notes from the previous run.",
        },
      }),
    );
    const freshRun = createAttemptCarryover();
    const completed = completeResult({ assistantTexts: ["The new task is still running."] });

    freshRun.apply(completed);
    const payloads = buildPayloads({
      isHeartbeatTrigger: true,
      assistantTexts: completed.assistantTexts,
      heartbeatToolResponse: completed.heartbeatToolResponse,
    });

    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe("The new task is still running.");
    expect(selectHeartbeatToolResponse(payloads)).toBeUndefined();
    expect(
      getReplyPayloadMetadata(expectDefined(payloads[0], "expected the fresh-run payload"))
        ?.heartbeatScratchProposal,
    ).toBeUndefined();
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
    const coreMedia = (result: ReturnType<typeof completeResult>) =>
      getCoreTtsAttemptResultMediaUrls(result, result.toolMediaUrls, TEST_OPERATIONAL_RUN_INSTANCE);
    expect(coreMedia(autoDeliveryResult)).toEqual(["/tmp/reply.opus"]);
    const alreadySentResult = completeResult({
      pendingToolMediaReply: { mediaUrls: ["/tmp/reply.opus"] },
      toolAutoDeliveryMediaUrls: ["/tmp/reply.opus"],
      messagingToolSentMediaUrls: ["/tmp/reply.opus"],
    });
    expect(coreMedia(alreadySentResult)).toEqual([]);
  });
});

describe("trailing source progress at runtime settlement", () => {
  const testModel = makeProviderModelFixture({
    id: "settle-model",
    name: "Settle Model",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
    contextWindow: 100_000,
    maxTokens: 8_000,
  });
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
    Object.assign(fixture.input.attempt, {
      messageChannel: "telegram",
      terminalReplyExpectation: "required",
    });
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
      finalizerInstruction: resolveSettledToolTerminalContinuation({
        executionContract: "strict-agentic",
        allowEmptyStopContinuation: true,
        replyDeliveryState: result.sourceReplyDeliveryState ?? "missing",
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
      expect(finalizerInstruction?.instruction).toContain("Your turn ended without a final reply.");
      expect(finalizerInstruction?.instruction).toContain("answer exactly NO_REPLY");
    }
  });
});
