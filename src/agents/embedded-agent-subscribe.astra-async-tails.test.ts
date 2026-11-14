import {
  type AssistantMessage,
  AssistantMessageEventStream,
  type Message,
} from "openclaw/plugin-sdk/llm";
import { Type } from "typebox";
import { expect, it, onTestFinished, vi } from "vitest";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { buildReplyPayloads } from "../auto-reply/reply/agent-runner-payloads.js";
import { createBlockReplyPipeline } from "../auto-reply/reply/block-reply-pipeline.js";
import { createBlockReplyDeliveryHandler } from "../auto-reply/reply/reply-delivery.js";
import { createTypingSignaler } from "../auto-reply/reply/typing-mode.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import { applyAssistantDeliveryDirectives } from "../config/sessions/transcript-assistant-delivery.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { createTestAdmittedRunContext } from "./admitted-run-context.test-support.js";
import type { EmbeddedRunAttemptWithReceiptEvidence } from "./embedded-agent-runner/run/attempt-result.js";
import { createEmbeddedRunContextRecoveryState } from "./embedded-agent-runner/run/context-recovery-state.js";
import { resolveFinalAssistantVisibleText } from "./embedded-agent-runner/run/helpers.js";
import { prepareEmbeddedRunTerminal } from "./embedded-agent-runner/run/terminal-preparation.js";
import { createUsageAccumulator } from "./embedded-agent-runner/usage-accumulator.js";
import { createSubscribedSessionHarness } from "./embedded-agent-subscribe.e2e-harness.js";
import { makeEmbeddedRunnerAttempt } from "./test-helpers/embedded-agent-runner-e2e-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const model = makeProviderModelFixture<"openai-responses">({
  id: "gpt-6-astra",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "https://api.openai.com/v1",
  reasoning: true,
  contextWindow: 200000,
  maxTokens: 8192,
});
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
      yield {
        type: "response.output_item.added",
        output_index: outputIndex,
        item: {
          ...item,
          status: "in_progress",
          ...(item.type === "message" ? { content: [] } : { arguments: "" }),
        },
      };
      if (item.type === "message") {
        yield {
          type: "response.output_text.delta",
          output_index: outputIndex,
          delta: item.content[0]?.text ?? "",
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
const voice = "/tmp/openclaw/tts-a/voice-a.opus";
type Scenario = {
  name: string;
  delivery: "deferred" | "live" | "off";
  requests: readonly Request[];
  delivered: readonly string[];
  reply?: { disposition: "visible"; text: string } | { disposition: "empty" | "silent" };
  trigger?: "cron";
  persistedFirst?: boolean;
  quiet?: boolean;
  reasoning?: boolean;
};
const answer = "Use counter B.";
const visible = (text: string): Scenario["reply"] => ({ disposition: "visible", text });
const scenario = (name: string, overrides: Partial<Omit<Scenario, "name">> = {}): Scenario => ({
  name,
  delivery: "deferred",
  requests: [answered, "NO_REPLY"],
  delivered: [answer],
  reply: visible(answer),
  ...overrides,
});
it.each([
  scenario("a later NO_REPLY keeps the completed answer"),
  scenario("an automation turn without block streaming keeps the completed answer", {
    delivery: "off",
    trigger: "cron",
  }),
  scenario("a live answer followed by commentary is not resent after NO_REPLY", {
    delivery: "live",
    requests: [
      [
        lookupCall,
        finalAnswer("msg_answer", "Alpha."),
        { ...finalAnswer("msg_note", "Wrapping up."), phase: "commentary" },
      ],
      "NO_REPLY",
    ],
    delivered: ["Alpha."],
    reply: visible("Alpha."),
  }),
  scenario("live blocks of a two-item terminal answer are not resent", {
    delivery: "live",
    requests: [
      [finalAnswer("msg_first", "First part."), finalAnswer("msg_second", "Second part.")],
    ],
    delivered: ["First part.", "Second part."],
    reply: visible("First part.Second part."),
  }),
  scenario("a repeated answer is delivered once", {
    requests: [answered, "Use counter B."],
  }),
  scenario("a later silent attachment supersedes the completed answer", {
    requests: [answered, `NO_REPLY\nMEDIA:${voice}`],
    delivered: [voice],
    reply: undefined,
  }),
  scenario("a NO_REPLY after a superseding attachment-only answer does not restore earlier text", {
    requests: [
      answered,
      [
        { ...lookupCall, id: "fc_lookup_2", call_id: "call_lookup_2" },
        finalAnswer("msg_media", `NO_REPLY\nMEDIA:${voice}`),
      ],
      "NO_REPLY",
    ],
    delivered: [voice],
    // The kept attachment answer owns the result; its parsed text is empty, not NO_REPLY.
    reply: { disposition: "empty" },
  }),
  scenario("a voice reply normalized to exact NO_REPLY before subscription stays silent", {
    requests: [answered, "NO_REPLY [[audio_as_voice]]"],
    delivered: [],
    reply: { disposition: "silent" },
    persistedFirst: true,
  }),
  scenario("a later NO_REPLY keeps pre-tool progress silent", {
    requests: [[finalAnswer("msg_progress", "Checking counter B."), lookupCall], "NO_REPLY"],
    delivered: [],
    reply: { disposition: "silent" },
  }),
  scenario("interim progress before a later NO_REPLY does not replace the completed answer", {
    requests: [
      answered,
      { items: [finalAnswer("msg_progress", "Exporting the rest now.")], endTurn: false },
      "NO_REPLY",
    ],
  }),
  scenario("quiet mode keeps the completed answer private", {
    delivered: ["Sent with the message tool."],
    quiet: true,
  }),
  scenario("reasoning sent with the completed answer is not repeated after NO_REPLY", {
    delivery: "live",
    requests: [[lookupCall, reasoning, finalAnswer("msg_answer", "Use counter B.")], "NO_REPLY"],
    delivered: ["Counter B is next to the entrance.", "Use counter B."],
    reasoning: true,
  }),
])("$name", async (row) => {
  const { delivery, requests, delivered, trigger = "user", quiet = false } = row;
  const sent: string[] = [];
  const show = (payload: { text?: string; mediaUrl?: string }) =>
    payload.text ?? payload.mediaUrl ?? "";
  const record = (payload: Parameters<typeof show>[0]) => {
    sent.push(show(payload));
  };
  const blockStreamingEnabled = delivery !== "off";
  const pipeline = createBlockReplyPipeline({
    onBlockReply: record,
    timeoutMs: 5000,
  });
  const handler = createBlockReplyDeliveryHandler({
    onBlockReply: record,
    normalizeStreamingText: (payload) => ({ text: payload.text, skip: false }),
    applyReplyToMode: (payload) => payload,
    typingSignals: createTypingSignaler({
      typing: createTypingController({}),
      mode: "never",
    }),
    blockStreamingEnabled,
    reasoningPayloadsEnabled: row.reasoning === true,
    blockReplyPipeline: pipeline,
    directBlockDeliveries: [],
  });
  type BeforeDelivery = NonNullable<
    Parameters<typeof createSubscribedSessionHarness>[0]["onBeforeTerminalDelivery"]
  >;
  const beforeTerminalDelivery = vi.fn<BeforeDelivery>(async () => undefined);
  const { subscription, emit } = createSubscribedSessionHarness({
    runId: "run",
    onBlockReply: handler,
    blockReplyBreak: "message_end",
    ...(delivery === "deferred" ? { onBeforeTerminalDelivery: beforeTerminalDelivery } : {}),
    ...(row.reasoning ? { reasoningMode: "on" as const } : {}),
  });
  onTestFinished(() => subscription.unsubscribe());
  const lookup = vi.fn(async () => ({
    content: [{ type: "text" as const, text: "Counter B is open." }],
    details: {},
  }));
  const pending = requests.map((request, index) => () => responsesStream(`resp_${index}`, request));
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
        history.filter((message): message is Message =>
          ["user", "assistant", "toolResult"].includes(message.role),
        ),
    },
    async (event) => {
      if (row.persistedFirst && event.type === "message_end") {
        // A backpressured subscriber sees the message after persistence normalized it.
        applyAssistantDeliveryDirectives(event.message);
      }
      emit(event);
      await subscription.waitForPendingEvents();
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
  await subscription.waitForPendingEvents();
  await pipeline.flush({ force: true });
  expect(pending).toEqual([]);
  const completed = subscription.getCurrentAttemptAssistant();
  const attempt: EmbeddedRunAttemptWithReceiptEvidence = {
    ...makeEmbeddedRunnerAttempt({
      sessionIdUsed: "session",
      messagesSnapshot: messages,
      assistantTexts: subscription.assistantTexts,
      lastAssistantTextMessageIndex: subscription.getLastAssistantTextMessageIndex(),
      toolMetas: subscription.toolMetas.filter(
        (meta): meta is typeof meta & { toolName: string } => meta.toolName !== undefined,
      ),
      lastAssistant: completed,
      currentAttemptCompletedAssistant: completed,
      didSendViaMessagingTool: quiet,
      ...(quiet
        ? { messagingToolSourceReplyPayloads: [{ text: "Sent with the message tool." }] }
        : {}),
      replayMetadata: { hadPotentialSideEffects: false, replaySafe: true },
      itemLifecycle: {
        startedCount: lookup.mock.calls.length,
        completedCount: lookup.mock.calls.length,
        activeCount: 0,
      },
    }),
    answerSegments: subscription.answerSegments,
    keptAnswer: subscription.getKeptAnswer(),
  };
  const runParams = {
    admittedRunContext: createTestAdmittedRunContext("run"),
    sessionId: "session",
    sessionKey: "agent:main:telegram:direct:astra",
    runId: "run",
    workspaceDir: "/tmp/openclaw-test",
    prompt: "Where do I store my bag?",
    timeoutMs: 60_000,
    trigger,
    ...(quiet ? { sourceReplyDeliveryMode: "message_tool_only" as const } : {}),
    ...(row.reasoning ? { reasoningLevel: "on" as const } : {}),
  } satisfies Parameters<typeof prepareEmbeddedRunTerminal>[0]["runParams"];
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
  const reply = row.reply;
  const visibleText = reply?.disposition === "visible" ? reply.text : undefined;
  if (delivery === "deferred" && visibleText !== undefined) {
    const lastAssistant = beforeTerminalDelivery.mock.calls.at(-1)?.[0].lastAssistant;
    expect(resolveFinalAssistantVisibleText(lastAssistant as AssistantMessage | undefined)).toBe(
      visibleText,
    );
  }
  const { replyPayloads } = await buildReplyPayloads({
    payloads: prepared.payloads,
    blockStreamingEnabled,
    blockReplyPipeline: pipeline,
    replyToMode: "off",
  });
  expect([...sent, ...replyPayloads.map(show)]).toEqual(delivered);
  if (row.reply) {
    expect(prepared.preparedTerminalReply.terminalReply).toEqual(row.reply);
  }
});
