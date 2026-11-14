import { AssistantMessageEventStream, type ToolCall } from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { Agent } from "../../../plugin-sdk/agent-core.js";
import { createHookRunner } from "../../../plugins/hooks.js";
import { createSubscribedSessionHarness } from "../../embedded-agent-subscribe.e2e-harness.js";
import {
  captureAgentPluginRuntimeRefresh,
  createAgentPluginRuntimeRefresh,
} from "../../plugin-runtime-refresh.js";
import { makeAssistantMessageFixture } from "../../test-helpers/assistant-message-fixtures.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { textToolResult } from "../../test-helpers/sparse-transcript.test-support.js";
import { getCoreTtsAttemptResultMediaUrls } from "../../tools/tts-tool-result-provenance.js";
import { recordEmbeddedToolReceipt } from "../tool-send-receipts.js";
import { completeEmbeddedAttemptResult } from "./attempt-result.js";
import { createSubscriptionMock } from "./attempt-spawn-workspace.subscription-mock.test-support.js";
import { createSettledStreamResult } from "./attempt-stream.test-helpers.js";
import { resolveSettledToolTerminalContinuation } from "./incomplete-turn-recovery.js";
import { buildPayloads } from "./payloads.test-helpers.js";
import { normalizeEmbeddedRunAttemptResult } from "./run-attempt-result.js";
import type { EmbeddedRunAttemptResult, EmbeddedRunAttemptTrajectoryRecorder } from "./types.js";

const TEST_OPERATIONAL_RUN_INSTANCE = { runId: "run-1" };
type ResultOwner = Parameters<typeof completeEmbeddedAttemptResult>;

type ResultInput = {
  terminal?: EmbeddedRunAttemptResult["terminal"];
  currentAttemptCompletedAssistant?: EmbeddedRunAttemptResult["currentAttemptCompletedAssistant"];
  hasSuccessfulModelResponse?: boolean;
  messagesSnapshot?: EmbeddedRunAttemptResult["messagesSnapshot"];
  latestMcpAppChannelView?: EmbeddedRunAttemptResult["latestMcpAppChannelView"];
  toolMetas?: EmbeddedRunAttemptResult["toolMetas"];
  replyOptional?: boolean;
  trajectoryRecorder?: EmbeddedRunAttemptTrajectoryRecorder;
  successfulNestedToolNames?: string[];
  clientToolCallSlots?: ResultOwner[0]["prepared"]["sessionRuntime"]["agentSession"]["clientToolCallSlots"];
  pendingToolMediaReply?: { mediaUrls?: string[]; audioAsVoice?: boolean };
  toolAutoDeliveryMediaUrls?: string[];
  messagingToolSentMediaUrls?: string[];
  didSendViaMessagingTool?: boolean;
  assistantTexts?: readonly string[];
  allowedToolNames?: string[];
  capabilityToolNames?: string[];
};

function createResultFixture(params: ResultInput = {}) {
  const state: ResultOwner[0]["state"] = {
    terminal: params?.terminal ?? { kind: "ok" },
    beforeAgentRunBlockedBy: undefined,
    trajectoryEndRecorded: false,
  };
  const settled: ResultOwner[1] = createSettledStreamResult({
    messagesSnapshot: params?.messagesSnapshot ?? [],
    currentAttemptCompletedAssistant: params?.currentAttemptCompletedAssistant,
    successfulNestedToolNames: params?.successfulNestedToolNames ?? [],
  });
  const prompt: ResultOwner[2] = {
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
      trigger: "user",
      terminalReplyExpectation: params?.replyOptional ? "optional" : undefined,
    },
    state,
    diagnostics: { diagnosticTrace: { traceId: "trace-1", spanId: "span-1" } },
    setup: { sessionAgentId: "main" },
    lifecycle: { readYieldState: () => ({ yieldDetected: false }) },
    prepared: {
      toolCatalog: {
        toolSearchRunPlan: {
          liveAllowedToolNames: new Set(params?.allowedToolNames),
          capabilityToolNames: new Set(params?.capabilityToolNames),
        },
      },
      bootstrap: { bootstrapPromptWarning: {} },
      systemPrompt: { systemPromptReport: undefined },
      sessionRuntime: {
        transport: { effectiveExtraParams: {} as Record<string, unknown> },
        agentSession: {
          clientToolCallSlots: params?.clientToolCallSlots ?? [],
          hasDeliveredSourceReply: () => false,
          hookRunner,
        },
        state: { promptCache: undefined },
        trajectoryRecorder: params?.trajectoryRecorder,
      },
    },
    preparedStreamRuntime: { stream: { subscription }, cache: {} },
  };
  return { input, state, settled, prompt, hookRunner };
}

function completeFixture({ input, settled, prompt }: ReturnType<typeof createResultFixture>) {
  return completeEmbeddedAttemptResult(input as never, settled, prompt);
}

function completeResult(params?: ResultInput) {
  return completeFixture(createResultFixture(params));
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
    { ...textToolResult("call-read", "read", "file contents"), isError: false, timestamp: 1 },
  ];
}

describe("attempt result projection", () => {
  it.each(["none", "transcript", "completion"] as const)(
    "attributes llm_output only to this attempt's %s assistant",
    (source) => {
      const previous = textAssistant("previous run", {
        stopReason: "aborted",
        errorMessage: "Previous run cancelled",
      });
      const current =
        source === "none" ? undefined : textAssistant("current run", { errorMessage: undefined });
      const fixture = createResultFixture({
        terminal:
          source === "none"
            ? { kind: "failed", source: "precheck", error: new Error("No tools allowed") }
            : { kind: "ok" },
        messagesSnapshot: [previous],
        currentAttemptCompletedAssistant: source === "completion" ? current : undefined,
      });
      fixture.settled.lastAssistant = previous;
      fixture.settled.currentAttemptAssistant = source === "transcript" ? current : undefined;
      vi.spyOn(fixture.hookRunner, "hasHooks").mockReturnValue(true);
      const output = vi.spyOn(fixture.hookRunner, "runLlmOutput").mockResolvedValue(undefined);

      const result = completeFixture(fixture);

      expect(output).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ runId: "run-1", lastAssistant: current }),
        expect.anything(),
      );
      expect(result.lastAssistant).toBe(previous);
    },
  );

  it("reports the effective Access setting even when it came from model configuration", () => {
    const fixture = createResultFixture();
    fixture.input.prepared.sessionRuntime.transport.effectiveExtraParams = {
      accessPrograms: { cyber: "daybreak_blue" },
    };
    expect(completeFixture(fixture).cyberAccessProgram).toBe("daybreak_blue");
  });

  it.each<[string[], string, number?]>([
    [["First part.", "Second part."], "First part.\nSecond part."],
    [["NO_RE", "PLY\nFirst part.", "Second part."], "First part.\nSecond part."],
    [["First part.", "Second part.\n\nNO_REPLY"], "First part.\nSecond part."],
    [["First part.\n", "NO_", "REPLY"], "First part."],
    [["Legacy context.", "Signed answer."], "Legacy context.\nSigned answer.", 1],
    [["Legacy context.", "Signed answer.\n\nNO_REPLY"], "Signed answer.", 1],
  ])("preserves native answer boundaries for %j", (parts, text, signedIndex) => {
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
      buildPayloads({ ...result, currentAssistant: assistant, lastAssistant: assistant }),
    ).toMatchObject([{ text }]);
  });

  // Syntax variants belong to packages/tool-call-repair/src/attempt.test.ts.
  it.each<[string, string[], boolean, true | undefined]>([
    ["Write", ["write"], false, true],
    ["functions.write", ["write"], false, true],
    ["WRITE", ["Write", "wriTE"], false, undefined],
    ["write", ["write"], false, true],
    ["write", ["write"], true, undefined],
  ])(
    "recognizes terminal callable %s (allowed=%j, native=%s)",
    (name, allowedToolNames, native, expected) => {
      const assistant = textAssistant(JSON.stringify({ name, arguments: { path: "proof.txt" } }));
      if (native) {
        assistant.content.push({ type: "toolCall", id: "native", name: "write", arguments: {} });
      }
      expect(
        completeResult({
          currentAttemptCompletedAssistant: assistant,
          allowedToolNames,
          toolMetas: [{ toolName: "read", replaySafe: true, isError: false }],
        }).textToolCallAttempt,
      ).toBe(expected);
    },
  );

  it.each([false, true])("corrects deferred text calls only when available: %s", (available) => {
    const assistant = textAssistant(
      "<tool_call>\n<function=skills_read>\n<parameter=name>\nbriefing\n</parameter>\n</function>\n</tool_call>",
    );
    expect(
      completeResult({
        currentAttemptCompletedAssistant: assistant,
        allowedToolNames: ["dispatch_action"],
        capabilityToolNames: available ? ["skills_read"] : [],
      }).textToolCallAttempt,
    ).toBe(available ? true : undefined);
  });

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

    const result = completeFixture(fixture);

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

  it.each([
    { refreshPending: true, outputs: 0 },
    { refreshPending: false, outputs: 1 },
  ])(
    "reports llm_output only once a refresh no longer continues the turn: $refreshPending",
    ({ refreshPending, outputs }) => {
      const fixture = createResultFixture({ hasSuccessfulModelResponse: true });
      vi.spyOn(fixture.hookRunner, "hasHooks").mockReturnValue(true);
      const output = vi.spyOn(fixture.hookRunner, "runLlmOutput").mockResolvedValue(undefined);

      // The attempt stopped at a step boundary for a pending refresh.
      createAgentPluginRuntimeRefresh().run(() => {
        const refresh = captureAgentPluginRuntimeRefresh();
        refresh.bindConsumer(() => true);
        if (refreshPending) {
          refresh.request();
          refresh.stopAtStep();
        }
        completeFixture(fixture);
      });

      expect(output).toHaveBeenCalledTimes(outputs);
    },
  );

  it("keeps current tool replay evidence separate from cumulative replay state", () => {
    const result = completeResult({ toolMetas: [{ toolName: "cron", replaySafe: false }] });

    expect([result.replayMetadata, result.currentAttemptReplayMetadata]).toEqual([
      { hadPotentialSideEffects: false, replaySafe: true },
      { hadPotentialSideEffects: true, replaySafe: false },
    ]);
  });

  const nonDeliverable = "non_deliverable_terminal_turn";
  it.each<[string, ResultInput, string?]>([
    ["uncorroborated messaging flag", { didSendViaMessagingTool: true }, nonDeliverable],
    [
      "completed refusal",
      {
        currentAttemptCompletedAssistant: makeAssistantMessageFixture({
          content: [],
          diagnostics: [{ type: "provider_refusal", timestamp: 1, details: { category: "cyber" } }],
        }),
      },
    ],
    [
      "completed empty length stop",
      {
        currentAttemptCompletedAssistant: textAssistant("", {
          content: [],
          stopReason: "length",
          errorMessage: undefined,
        }),
      },
      nonDeliverable,
    ],
    ["actually empty optional turn", {}, nonDeliverable],
  ])("records %s after transcript projection", (_label, params, terminalError) => {
    const recordEvent = vi.fn<EmbeddedRunAttemptTrajectoryRecorder["recordEvent"]>();
    const result = completeResult({
      ...params,
      replyOptional: !params.didSendViaMessagingTool,
      trajectoryRecorder: { recordEvent, flush: async () => {} },
    });

    expect(result.currentAttemptAssistant).toBeUndefined();
    expect(result.currentAttemptCompletedAssistant).toEqual(
      params.currentAttemptCompletedAssistant,
    );
    if (params.didSendViaMessagingTool) {
      expect(result.didSendViaMessagingTool).toBe(true);
    }
    expect(recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({ status: "error", terminalError }),
    );
  });

  const failed = (error: Error): ResultInput => ({
    terminal: { kind: "failed", source: "prompt", error },
  });
  const websocketFailure: ResultInput = {
    currentAttemptCompletedAssistant: makeAssistantMessageFixture({
      stopReason: "error",
      errorMessage: "WebSocket error",
      errorCode: "ERR_WEBSOCKET_TRANSPORT",
    }),
  };
  const truncated = failed(new Error("Stream ended without finish_reason"));
  const commentary = "Checking the post-reboot state.";
  const afterRead = (text: string, authored = false): ResultInput => ({
    ...truncated,
    assistantTexts: authored ? [text] : [],
    messagesSnapshot: [
      ...settledToolMessages(),
      textAssistant(text, authored ? { errorMessage: undefined, timestamp: 2 } : {}),
    ],
  });
  it.each<[string, ResultInput, boolean]>([
    ["policy denial", failed(new Error("content policy violation")), false],
    ["assistant WebSocket error", websocketFailure, true],
    [
      "only pre-tool commentary",
      {
        ...truncated,
        assistantTexts: [commentary],
        messagesSnapshot: [
          textAssistant(commentary, {
            stopReason: "toolUse",
            errorMessage: undefined,
            timestamp: 1,
            content: [
              { type: "text", text: commentary },
              { type: "toolCall", id: "call-read", name: "read", arguments: {} },
            ],
          }),
          ...settledToolMessages(),
          makeAssistantMessageFixture({
            errorMessage: "Stream ended without finish_reason",
            timestamp: 3,
            content: [],
          }),
        ],
      },
      true,
    ],
    ["snapshot-only media", afterRead("MEDIA:https://example.com/result.png"), false],
    ["post-tool authored text", afterRead("here is the answer", true), false],
    [
      "assistant tool_execution timeout",
      {
        ...websocketFailure,
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
    const projectMedia = (pendingToolMediaReply?: ResultInput["pendingToolMediaReply"]) => {
      const { toolMediaUrls, toolAudioAsVoice } = completeResult({ pendingToolMediaReply });
      return { toolMediaUrls, toolAudioAsVoice };
    };
    expect(projectMedia()).toEqual({ toolMediaUrls: undefined, toolAudioAsVoice: undefined });
    expect(projectMedia({ mediaUrls: [" "] }).toolMediaUrls).toEqual([" "]);
    expect(projectMedia({ mediaUrls: ["file:///tmp/result.png"] }).toolMediaUrls).toEqual([
      "file:///tmp/result.png",
    ]);
    expect(projectMedia({ audioAsVoice: true }).toolAudioAsVoice).toBe(true);
    const mediaUrls = ["/tmp/reply.opus"];
    const coreMedia = (messagingToolSentMediaUrls: string[] = []) => {
      const result = completeResult({
        pendingToolMediaReply: { mediaUrls },
        toolAutoDeliveryMediaUrls: mediaUrls,
        messagingToolSentMediaUrls,
      });
      return getCoreTtsAttemptResultMediaUrls(
        result,
        result.toolMediaUrls,
        TEST_OPERATIONAL_RUN_INSTANCE,
      );
    };
    expect(coreMedia()).toEqual(mediaUrls);
    expect(coreMedia(mediaUrls)).toEqual([]);
  });
});

describe("trailing source progress at runtime settlement", () => {
  const testModel = makeProviderModelFixture({
    id: "settle-model",
    api: "openai-responses",
    provider: "test",
    baseUrl: "https://example.test",
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
    let callIndex = 0;
    const tools = ["message", "read"].map((name) => ({
      name,
      label: name,
      description: name,
      parameters: Type.Object({}, { additionalProperties: true }),
      execute: async (toolCallId: string) => {
        if (name === "message") {
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
          );
        }
        return { content: [{ type: "text" as const, text: "ok" }], details: {} };
      },
    }));
    const toolSettled = new Map<string, ReturnType<typeof createDeferred<void>>>();
    const settledFor = (toolCallId: string) => {
      const settled = toolSettled.get(toolCallId) ?? createDeferred();
      toolSettled.set(toolCallId, settled);
      return settled;
    };
    const agent = new Agent({
      initialState: {
        model: testModel,
        tools,
      },
      streamFn: () => {
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
    });
    agent.subscribe(async (event) => {
      emit(event);
      if (event.type === "tool_execution_end" || event.type === "agent_end") {
        await subscription.waitForPendingEvents();
        if (event.type === "tool_execution_end") {
          settledFor(event.toolCallId).resolve();
        }
      }
    });
    await agent.prompt({ role: "user", content: "Run the report.", timestamp: 0 });
    const messages = agent.state.messages;
    expect(callIndex).toBe(calls.length);
    const terminalAssistant = messages.findLast((message) => message.role === "assistant");
    const fixture = createResultFixture({
      currentAttemptCompletedAssistant: terminalAssistant as never,
      messagesSnapshot: messages,
    });
    Object.assign(fixture.input.attempt, {
      messageChannel: "telegram",
      terminalReplyExpectation: "required",
    });
    fixture.input.preparedStreamRuntime.stream.subscription = subscription as never;
    fixture.settled.currentAttemptAssistant = terminalAssistant as never;
    const result = completeFixture(fixture);
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
