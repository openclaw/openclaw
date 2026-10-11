import {
  type AssistantMessage,
  AssistantMessageEventStream,
  type Message,
  type Model,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { buildReplyPayloads } from "../auto-reply/reply/agent-runner-payloads.js";
import { createBlockReplyPipeline } from "../auto-reply/reply/block-reply-pipeline.js";
import { createBlockReplyDeliveryHandler } from "../auto-reply/reply/reply-delivery.js";
import { createTypingSignaler } from "../auto-reply/reply/typing-mode.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { attachSessionTranscriptRunId } from "../sessions/transcript-events.js";
import { matchesTranscriptEvent } from "../sessions/transcript-visible-record.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import { buildAgentRunTerminalReplySnapshot } from "./agent-run-terminal-reply.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./embedded-agent-runner/run/attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./embedded-agent-runner/run/context-recovery-state.js";
import { resolveFinalAssistantVisibleText } from "./embedded-agent-runner/run/helpers.js";
import { prepareEmbeddedRunTerminal } from "./embedded-agent-runner/run/terminal-preparation.js";
import { resolveSettledTurnFinalizationRequest } from "./embedded-agent-runner/run/terminal-resolution.js";
import { createUsageAccumulator } from "./embedded-agent-runner/usage-accumulator.js";
import {
  createSubscribedSessionHarness,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { readSubagentRunAnnounceResultUsing } from "./subagents/announce/subagent-announce-result.js";
import type { SubagentRunRecord } from "./subagents/registry/subagent-registry.types.js";

type Options = Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">;
function setup(options: Options = {}) {
  const onBlockReply = vi.fn();
  const harness = createSubscribedSessionHarness({
    runId: "run",
    onBlockReply,
    blockReplyBreak: "text_end",
    ...options,
  });
  onTestFinished(() => harness.subscription.unsubscribe());
  return { ...harness, onBlockReply, texts: () => extractTextPayloads(onBlockReply.mock.calls) };
}

describe("Astra async response tails", () => {
  const model: Model<"openai-responses"> = {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200000,
    maxTokens: 8192,
  };
  const lookupCall = {
    type: "function_call" as const,
    id: "fc_lookup",
    call_id: "call_lookup",
    name: "lookup",
    arguments: "{}",
    status: "completed",
    async: true,
  };
  const finalAnswer = (id: string, text: string) => ({
    type: "message" as const,
    id,
    role: "assistant",
    status: "completed",
    phase: "final_answer",
    content: [{ type: "output_text", text, annotations: [] }],
  });
  const reasoning = {
    type: "reasoning" as const,
    id: "rs_answer",
    summary: [{ type: "summary_text", text: "Counter B is next to the entrance." }],
  };
  type WireItem = typeof lookupCall | typeof reasoning | ReturnType<typeof finalAnswer>;
  type Request =
    | string
    | readonly WireItem[]
    | { readonly items: readonly WireItem[]; readonly endTurn: false };
  // Each model request is a real Responses wire stream through the shipped transport.
  function responsesStream(id: string, request: Request) {
    const items: readonly WireItem[] =
      typeof request === "string"
        ? [finalAnswer(`msg_${id}`, request)]
        : "items" in request
          ? request.items
          : request;
    const endTurn = typeof request === "object" && "endTurn" in request ? request.endTurn : true;
    async function* wire() {
      for (const [outputIndex, item] of items.entries()) {
        if (item.type === "message") {
          yield {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { ...item, status: "in_progress", content: [] },
          };
          yield {
            type: "response.output_text.delta",
            output_index: outputIndex,
            delta: item.content[0]?.text ?? "",
          };
        } else {
          yield {
            type: "response.output_item.added",
            output_index: outputIndex,
            item: { ...item, status: "in_progress", arguments: "" },
          };
        }
        yield { type: "response.output_item.done", output_index: outputIndex, item };
      }
      yield {
        type: "response.completed",
        response: { id, status: "completed", output: items, end_turn: endTurn },
      };
    }
    const output = createResponsesAssistantOutput(model);
    const response = new AssistantMessageEventStream();
    response.push({ type: "start", partial: output });
    void processResponsesStream(wire(), output, response, model, {
      asyncToolExecution: true,
    }).then(
      () => {
        response.push({
          type: "done",
          reason: output.stopReason === "toolUse" ? "toolUse" : "stop",
          message: output,
        });
        response.end();
      },
      (error: unknown) => {
        response.end({ ...output, stopReason: "error", errorMessage: String(error) });
      },
    );
    return response;
  }

  const answered = [lookupCall, finalAnswer("msg_answer", "Use counter B.")];
  const answeredTail = ["toolUse:toolCall", "stop:text", "stop:text"];
  const keptReply = { disposition: "visible", text: "Use counter B." } as const;
  it.each([
    {
      name: "a later NO_REPLY keeps the completed answer",
      delivery: "deferred",
      requests: [answered, "NO_REPLY"],
      transcript: answeredTail,
      delivered: ["Use counter B."],
      reply: keptReply,
    },
    {
      name: "an automation turn without block streaming keeps the completed answer",
      delivery: "off",
      requests: [answered, "NO_REPLY"],
      transcript: answeredTail,
      delivered: ["Use counter B."],
      reply: keptReply,
      trigger: "cron",
    },
    {
      name: "a live answer followed by commentary is not resent after NO_REPLY",
      delivery: "live",
      requests: [
        [
          lookupCall,
          finalAnswer("msg_answer", "Alpha."),
          { ...finalAnswer("msg_note", "Wrapping up."), phase: "commentary" },
        ],
        "NO_REPLY",
      ],
      transcript: ["toolUse:toolCall", "stop:text+text", "stop:text"],
      delivered: ["Alpha."],
      reply: { disposition: "visible", text: "Alpha." },
    },
    {
      name: "live blocks of a two-item terminal answer are not resent",
      delivery: "live",
      requests: [
        [finalAnswer("msg_first", "First part."), finalAnswer("msg_second", "Second part.")],
      ],
      transcript: ["stop:text+text"],
      delivered: ["First part.", "Second part."],
      reply: { disposition: "visible", text: "First part.\nSecond part." },
    },
    {
      name: "a repeated answer is delivered once",
      delivery: "deferred",
      requests: [answered, "Use counter B."],
      transcript: answeredTail,
      delivered: ["Use counter B."],
      reply: keptReply,
    },
    {
      name: "a later silent attachment supersedes the completed answer",
      delivery: "deferred",
      requests: [answered, "NO_REPLY\nMEDIA:/tmp/openclaw/tts-a/voice-a.opus"],
      transcript: answeredTail,
      delivered: ["/tmp/openclaw/tts-a/voice-a.opus"],
    },
    {
      name: "a NO_REPLY after a superseding silent attachment does not restore the earlier answer",
      delivery: "deferred",
      requests: [
        answered,
        [
          { ...lookupCall, id: "fc_lookup_2", call_id: "call_lookup_2" },
          finalAnswer("msg_media", "NO_REPLY\nMEDIA:/tmp/openclaw/tts-a/voice-a.opus"),
        ],
        "NO_REPLY",
      ],
      transcript: ["toolUse:toolCall", "stop:text", "toolUse:toolCall", "stop:text", "stop:text"],
      delivered: ["/tmp/openclaw/tts-a/voice-a.opus"],
      reply: { disposition: "silent" },
    },
    {
      name: "a later voice NO_REPLY that persistence normalized first supersedes the completed answer",
      delivery: "deferred",
      requests: [answered, "NO_REPLY [[audio_as_voice]]"],
      transcript: answeredTail,
      delivered: [],
      reply: { disposition: "silent" },
      persistedFirst: true,
    },
    {
      name: "a later NO_REPLY keeps pre-tool progress silent",
      delivery: "deferred",
      requests: [[finalAnswer("msg_progress", "Checking counter B."), lookupCall], "NO_REPLY"],
      transcript: ["toolUse:text+toolCall", "stop:", "stop:text"],
      delivered: [],
      reply: { disposition: "silent" },
    },
    {
      name: "interim progress before a later NO_REPLY does not replace the completed answer",
      delivery: "deferred",
      requests: [
        answered,
        { items: [finalAnswer("msg_progress", "Exporting the rest now.")], endTurn: false },
        "NO_REPLY",
      ],
      transcript: [...answeredTail, "stop:text"],
      delivered: ["Use counter B."],
      reply: keptReply,
      announce: true,
    },
    {
      name: "quiet mode keeps the completed answer private",
      delivery: "deferred",
      requests: [answered, "NO_REPLY"],
      transcript: answeredTail,
      delivered: ["Sent with the message tool."],
      reply: keptReply,
      quiet: true,
    },
    {
      name: "reasoning sent with the completed answer is not repeated after NO_REPLY",
      delivery: "live",
      requests: [[lookupCall, reasoning, finalAnswer("msg_answer", "Use counter B.")], "NO_REPLY"],
      transcript: answeredTail,
      delivered: ["Counter B is next to the entrance.", "Use counter B."],
      reply: keptReply,
      reasoning: true,
    },
  ] as const)("$name", async ({ delivery, requests, transcript, delivered, ...row }) => {
    const quiet = "quiet" in row;
    const sent: string[] = [];
    const show = (payload: { text?: string; mediaUrl?: string }) =>
      payload.text ?? payload.mediaUrl ?? "";
    const blockStreamingEnabled = delivery !== "off";
    const pipeline = createBlockReplyPipeline({
      onBlockReply: (payload) => {
        sent.push(show(payload));
      },
      timeoutMs: 5000,
    });
    const handler = createBlockReplyDeliveryHandler({
      onBlockReply: (payload) => {
        sent.push(show(payload));
      },
      normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
      applyReplyToMode: (payload) => payload,
      typingSignals: createTypingSignaler({
        typing: createTypingController({}),
        mode: "never",
      }),
      blockStreamingEnabled,
      reasoningPayloadsEnabled: "reasoning" in row,
      blockReplyPipeline: pipeline,
      directBlockDeliveries: [],
    });
    // Required user replies defer terminal delivery; optional turns stream blocks live.
    const beforeTerminalDelivery = vi.fn<NonNullable<Options["onBeforeTerminalDelivery"]>>(
      async () => undefined,
    );
    const h = setup({
      onBlockReply: handler,
      blockReplyBreak: "message_end",
      ...(delivery === "deferred" ? { onBeforeTerminalDelivery: beforeTerminalDelivery } : {}),
      ...("reasoning" in row ? { reasoningMode: "on" as const } : {}),
    });
    const lookup = vi.fn(async () => ({
      content: [{ type: "text" as const, text: "Counter B is open." }],
      details: {},
    }));
    const pending = requests.map(
      (request, index) => () => responsesStream(`resp_${index}`, request),
    );
    const messages = await runAgentLoop(
      [{ role: "user", content: "Where do I store my bag?", timestamp: 1 }],
      {
        systemPrompt: "",
        messages: [],
        tools: [
          {
            name: "lookup",
            label: "lookup",
            description: "lookup",
            parameters: Type.Object({}),
            execute: lookup,
          },
        ],
      },
      {
        model,
        convertToLlm: (history) =>
          history.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
      },
      async (event) => {
        if ("persistedFirst" in row && event.type === "message_end") {
          // A backpressured subscriber sees the message after persistence normalized it.
          applyAssistantDeliveryDirectives(event.message);
        }
        h.emit(event);
        await h.subscription.waitForPendingEvents();
      },
      undefined,
      () => {
        const next = pending.shift();
        if (!next) {
          throw new Error("unexpected model request");
        }
        return next();
      },
    );
    await h.subscription.waitForPendingEvents();
    await pipeline.flush({ force: true });
    expect(pending).toEqual([]);
    // The call-free tail ended the provider response; only the call fragment uses tools.
    expect(
      messages.flatMap((message) =>
        message.role === "assistant"
          ? [
              `${message.stopReason}:${message.content
                .map((item) => item.type)
                .filter((type) => type !== "thinking")
                .join("+")}`,
            ]
          : [],
      ),
    ).toEqual(transcript);
    const completed = h.subscription.getCurrentAttemptAssistant();
    const attempt: EmbeddedRunAttemptWithReceiptEvidence = {
      terminal: { kind: "ok" },
      sessionIdUsed: "session",
      messagesSnapshot: messages,
      assistantTexts: h.subscription.assistantTexts,
      answerSegments: h.subscription.answerSegments,
      keptAnswer: h.subscription.getKeptAnswer(),
      lastAssistantTextMessageIndex: h.subscription.getLastAssistantTextMessageIndex(),
      toolMetas: h.subscription.toolMetas.filter(
        (meta): meta is typeof meta & { toolName: string } => meta.toolName !== undefined,
      ),
      lastAssistant: completed,
      currentAttemptAssistant: completed,
      currentAttemptCompletedAssistant: completed,
      didSendViaMessagingTool: quiet,
      messagingToolSentTexts: [],
      messagingToolSentMediaUrls: [],
      messagingToolSentTargets: [],
      ...(quiet
        ? { messagingToolSourceReplyPayloads: [{ text: "Sent with the message tool." }] }
        : {}),
      cloudCodeAssistFormatError: false,
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      itemLifecycle: {
        startedCount: lookup.mock.calls.length,
        completedCount: lookup.mock.calls.length,
        activeCount: 0,
      },
    };
    const runParams = {
      admittedRunContext: createTestAdmittedRunContext("run"),
      sessionId: "session",
      sessionKey: "agent:main:telegram:direct:astra",
      runId: "run",
      workspaceDir: "/tmp/openclaw-test",
      prompt: "Where do I store my bag?",
      timeoutMs: 60_000,
      trigger: "trigger" in row ? row.trigger : ("user" as const),
      ...(quiet ? { sourceReplyDeliveryMode: "message_tool_only" as const } : {}),
      ...("reasoning" in row ? { reasoningLevel: "on" as const } : {}),
    };
    const terminalState = {
      outcome: { reason: "completed", status: "ok", stopReason: "stop" } as const,
      signalOwnedInterruption: false,
    };
    const prepared = prepareEmbeddedRunTerminal({
      runParams,
      attempt,
      currentAttemptCompletedAssistant: completed,
      provider: "openai",
      model: model.id,
      activeErrorContext: { provider: "openai", model: model.id },
      authProfileStore: { version: 1, profiles: {} },
      sessionIdUsed: "session",
      outerContextTokenMeta: {},
      usageAccumulator: createUsageAccumulator(),
      contextRecoveryState: createEmbeddedRunContextRecoveryState(),
      resolvedToolResultFormat: "markdown",
      terminalState,
    });
    const reply = "reply" in row ? row.reply : undefined;
    const visibleText = reply?.disposition === "visible" ? reply.text : undefined;
    if (visibleText !== undefined && !quiet) {
      // Settled-turn recovery must not replace an answer the turn already composed.
      expect(
        resolveSettledTurnFinalizationRequest({
          runParams,
          attempt,
          activeErrorContext: { provider: "openai", model: model.id },
          modelApi: model.api,
          executionContract: undefined,
          payloadsWithToolMedia: prepared.payloadsWithToolMedia,
          hasTerminalToolPresentation: false,
          terminalState,
          settledTurnFinalizationAvailable: true,
        }),
      ).toBeNull();
    }
    if (delivery === "deferred" && visibleText !== undefined) {
      // before_agent_finalize projects its lastAssistantMessage from this input.
      expect(
        resolveFinalAssistantVisibleText(
          beforeTerminalDelivery.mock.calls.at(-1)?.[0].lastAssistant as
            | AssistantMessage
            | undefined,
        ),
      ).toBe(visibleText);
    }
    const { replyPayloads } = await buildReplyPayloads({
      payloads: prepared.payloads,
      didLogHeartbeatStrip: false,
      blockStreamingEnabled,
      blockReplyPipeline: pipeline,
      replyToMode: "off",
    });
    expect([...sent, ...replyPayloads.map(show)]).toEqual(delivered);
    if ("reply" in row) {
      // Sub-agent completion and A2A forwarding read the terminal reply, not the payloads.
      expect(
        buildAgentRunTerminalReplySnapshot({
          visibleText: prepared.finalAssistantVisibleText,
          rawText: prepared.finalAssistantRawText,
        }),
      ).toEqual(row.reply);
    }
    if ("announce" in row) {
      // A parent's sub-agent announcement hydrates the answer from the persisted rows.
      const events = messages.map((message, index) => ({
        type: "message",
        id: `entry-${index}`,
        message: attachSessionTranscriptRunId(message, "run"),
      }));
      const child: SubagentRunRecord = {
        runId: "run",
        childSessionKey: "agent:main:subagent:astra",
        requesterSessionKey: "agent:main:main",
        requesterDisplayKey: "main",
        task: "Where do I store my bag?",
        cleanup: "keep",
        createdAt: 1,
        execution: {
          status: "terminal",
          outcome: { status: "ok" },
          transcriptTarget: {
            agentId: "main",
            sessionId: "session",
            sessionKey: "agent:main:subagent:astra",
            storePath: "/tmp/openclaw-test/sessions.json",
          },
        },
        completion: {
          required: true,
          terminalReply: buildAgentRunTerminalReplySnapshot({
            visibleText: prepared.finalAssistantVisibleText,
            rawText: prepared.finalAssistantRawText,
          }),
        },
      };
      const unexpected = () => {
        throw new Error("unexpected session fallback");
      };
      const announced = await readSubagentRunAnnounceResultUsing(child, {
        readSubagentRun: () => child,
        findTranscriptEvent: async (_target, match) => {
          const event = events.findLast((candidate) => matchesTranscriptEvent(candidate, match));
          return event === undefined ? undefined : { event };
        },
        findSessionTranscriptArchiveEventReadOnly: async () => undefined,
        getRuntimeConfig: unexpected,
        readSubagentSessionEntry: unexpected,
        resolveAgentIdFromSessionKey: unexpected,
        resolveSessionStorePathCore: unexpected,
      });
      expect(announced.text).toBe("Use counter B.");
    }
  });
});
