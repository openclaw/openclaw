import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished } from "vitest";
import {
  consumeGoogleGenerateContentStream,
  type GoogleStreamChunk,
} from "../../packages/ai/src/providers/google-stream.js";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { createAssistantOutput } from "../../packages/ai/src/transports/assistant-output.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { awaitGateBeforeSettlement, createDeferred } from "../../test/helpers/promise.js";
import { copyReplyPayloadMetadata, getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { isAudioPayload } from "../auto-reply/reply/agent-runner-helpers.js";
import { createBlockReplyPipeline } from "../auto-reply/reply/block-reply-pipeline.js";
import { createBlockReplyDeliveryHandler } from "../auto-reply/reply/reply-delivery.js";
import { parseReplyDirectives } from "../auto-reply/reply/reply-directives.js";
import { createReplyToModeFilterForChannel } from "../auto-reply/reply/reply-threading.js";
import { createTypingSignaler } from "../auto-reply/reply/typing-mode.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { createAutomationResultRecorder } from "../infra/agent-run-registry.automation.js";
import { claimAgentRunContext, releaseAgentRunContext } from "../infra/agent-run-registry.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import { blockDirectiveCases } from "./embedded-agent-subscribe.directive-delivery.block-code.test-support.js";
import { inlineDirectiveCases } from "./embedded-agent-subscribe.directive-delivery.inline-code.test-support.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import { resolveManagedStreamMediaUrls } from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { createStreamingReplyResolver } from "./embedded-agent-subscribe.handlers.messages.stream.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "./test-helpers/provider-model-fixture.js";

const googleModel = makeProviderModelFixture<"google-generative-ai">({
  id: "gemini-2.5-flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.invalid",
});
const responsesModel: Model<"openai-responses"> = {
  ...googleModel,
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
};
const audioUrl = "https://example.invalid/clip.ogg";
const nextParagraph = "A second paragraph gives the completed example enough text to drain.\n\n";
const texts = (payloads: ReplyPayload[]) => payloads.map((payload) => payload.text ?? "");
const hasNoMedia = (payload: ReplyPayload) => !payload.mediaUrl && !payload.mediaUrls?.length;
const hasNoReplyTarget = (payload: ReplyPayload) =>
  !payload.replyToId && !payload.replyToCurrent && !payload.replyToTag;
const googleChunk = (
  parts: NonNullable<NonNullable<GoogleStreamChunk["candidates"]>[number]["content"]>["parts"],
  finishReason?: string,
): GoogleStreamChunk => ({
  candidates: [{ ...(parts ? { content: { parts } } : {}), finishReason }],
});
function googleResponse(chunks: AsyncIterable<GoogleStreamChunk>, profile: "managed" | "sdk") {
  const response = new AssistantMessageEventStream();
  const producing = consumeGoogleGenerateContentStream({
    chunks,
    model: googleModel,
    output: createAssistantOutput(googleModel),
    stream: response,
    profile,
    nextToolCallId: () => "unused-tool",
  });
  return { response, producing };
}

function responsesResponse(chunks: string[], terminalText: string, release: Promise<void>) {
  const response = new AssistantMessageEventStream();
  const output = createResponsesAssistantOutput(responsesModel);
  const item = { type: "message", id: "answer", role: "assistant", phase: "final_answer" };
  async function* events() {
    yield { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } };
    for (const delta of chunks) {
      yield { type: "response.output_text.delta", output_index: 0, delta };
    }
    await release;
    yield {
      type: "response.completed",
      response: {
        id: "response",
        status: "completed",
        output: [
          {
            ...item,
            status: "completed",
            content: [{ type: "output_text", text: terminalText, annotations: [] }],
          },
        ],
      },
    };
  }
  response.push({ type: "start", partial: output });
  const producing = processResponsesStream(events(), output, response, responsesModel).then(() => {
    response.push({ type: "done", reason: "stop", message: output });
    response.end();
  });
  return { response, producing };
}

function createDeliveryHarness(
  options: { minChars?: number; blockReplyBreak?: "text_end" | "message_end" } = {},
) {
  const delivered: ReplyPayload[] = [];
  const blocks: ReplyPayload[] = [];
  const record = (payload: ReplyPayload) => {
    delivered.push(structuredClone(payload));
  };
  const pipeline = createBlockReplyPipeline({
    onBlockReply: record,
    timeoutMs: 5000,
    isAudioPayload,
  });
  const typing = createTypingController({});
  const handler = createBlockReplyDeliveryHandler({
    onBlockReply: record,
    replyThreading: { implicitCurrentMessage: "deny" },
    normalizeStreamingText: (payload) => {
      const text = sanitizeUserFacingText(payload.text ?? "", { streaming: true });
      return { text, skip: !text.trim() };
    },
    applyReplyToMode: createReplyToModeFilterForChannel("all"),
    typingSignals: createTypingSignaler({ typing, mode: "never" }),
    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
    directBlockDeliveries: [],
  });
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run-directive-delivery",
    onBlockReply: (payload) => {
      blocks.push(copyReplyPayloadMetadata(payload, structuredClone(payload)));
      return handler(payload);
    },
    blockReplyBreak: options.blockReplyBreak ?? "text_end",
    blockReplyChunking: {
      minChars: options.minChars ?? 1,
      maxChars: 50,
      breakPreference: "newline",
    },
  });
  const flush = async () => {
    await subscription.waitForPendingEvents();
    await pipeline.flush({ force: true });
  };
  onTestFinished(async () => {
    await flush();
    subscription.unsubscribe();
    pipeline.stop();
    typing.cleanup();
  });
  return { delivered, blocks, pipeline, handler, emit, subscription, flush };
}

it.each(["no_change", "progress"] as const)(
  "leaves scheduled reply publication to final delivery (%s)",
  async (outcome) => {
    const runId = "run-directive-delivery";
    const claim = claimAgentRunContext(
      runId,
      {
        cronRunsByJobId: new Map([["job", { nextCheckEnabled: false, assertCurrent: () => {} }]]),
      },
      { trackOwner: true, ownsContext: true },
    );
    onTestFinished(() => releaseAgentRunContext(runId, claim));
    const harness = createDeliveryHarness();
    const text = "The check completed with a useful result.";
    const message = makeAgentAssistantMessage({ content: [{ type: "text", text }] });
    harness.emit({ type: "message_start", message });
    emitAssistantTextDelta({ emit: harness.emit, delta: text });
    harness.emit({ type: "message_end", message });
    await harness.flush();
    expect(harness.delivered).toEqual([]);
    createAutomationResultRecorder(runId, "job")({ outcome, summary: "Check complete." });
    harness.emit({ type: "message_start", message });
    emitAssistantTextDelta({ emit: harness.emit, delta: "The check completed." });
    harness.emit({ type: "message_end", message });
    await harness.flush();
    expect(harness.delivered).toEqual([]);
  },
);

type Delivery = ReturnType<typeof createDeliveryHarness>;
function runDeliveryLoop(
  harness: Pick<Delivery, "emit" | "subscription">,
  model: Model<"google-generative-ai"> | Model<"openai-responses">,
  response: AssistantMessageEventStream,
  onDelta: (delta: string) => Promise<void>,
) {
  return runAgentLoop(
    [{ role: "user", content: "Explain the marker syntax.", timestamp: 1 }],
    { systemPrompt: "", messages: [] },
    {
      model,
      convertToLlm: (messages) =>
        messages.filter(
          (m): m is Message =>
            m.role === "user" || m.role === "assistant" || m.role === "toolResult",
        ),
    },
    async (event) => {
      harness.emit(event);
      await harness.subscription.waitForPendingEvents();
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        await onDelta(event.assistantMessageEvent.delta);
      }
    },
    undefined,
    () => response,
  );
}

function textMessage(text: string | string[], item?: number) {
  return {
    ...createAssistantOutput(item === undefined ? googleModel : responsesModel),
    content: (typeof text === "string" ? [text] : text).map((part) => ({
      type: "text" as const,
      text: part,
      textSignature:
        item === undefined
          ? undefined
          : JSON.stringify({ v: 1, id: `item-${item}`, phase: "final_answer" }),
    })),
  };
}

function emitText(
  emit: Delivery["emit"],
  type: "text_delta" | "text_end",
  text: string,
  { item, delta = text }: { item?: number; delta?: string } = {},
) {
  const partial = textMessage(text, item);
  emit({
    type: "message_update",
    message: partial,
    assistantMessageEvent: {
      type,
      contentIndex: item ?? 0,
      partial,
      ...(type === "text_delta" ? { delta } : { content: text }),
    },
  });
}

const replacementChunks = [
  "The current value is one for this item. Continue. ",
  "Keep this sentence unchanged. Retain each result. ",
  "The final summary also remains unchanged.\n",
] as const;
const leadChunks = ["First lead stays.\n", "Next lead stays.\n"];
const correctedText = replacementChunks.join("").replace("one", "thirty-three").trimEnd();
const prefixCorrection = {
  name: "authoritative prefix correction with early chunks",
  chunks: [...leadChunks, ...replacementChunks],
  marker: "Keep this sentence unchanged.",
  unchangedLeadSentences: leadChunks.map((text) => text.trimEnd()),
  literal: true,
  terminalText: leadChunks.join("") + correctedText + "\n",
  correctedText,
};

it.each([...blockDirectiveCases, ...inlineDirectiveCases, prefixCorrection])(
  "preserves $name through the delivery handler",
  async (scenario) => {
    const { delivered, pipeline, emit, subscription, flush } = createDeliveryHarness();
    const hasAudio = "audioAsVoice" in scenario;
    const chunks = [
      ...scenario.chunks,
      ...("terminalText" in scenario ? [] : [nextParagraph]),
      ...(hasAudio ? [`MEDIA:${audioUrl}`] : []),
    ];
    const beforeEnd = createDeferred();
    const releaseTerminal = createDeferred();
    async function* googleEvents() {
      for (const text of chunks) {
        yield googleChunk([{ text }]);
      }
      await releaseTerminal.promise;
      yield googleChunk(undefined, "STOP");
    }
    const prepared = "terminalText" in scenario;
    const model = prepared ? responsesModel : googleModel;
    const { response, producing } = prepared
      ? responsesResponse(chunks, scenario.terminalText, releaseTerminal.promise)
      : googleResponse(googleEvents(), "managed");
    let receivedText = "";
    const running = runDeliveryLoop({ emit, subscription }, model, response, async (delta) => {
      receivedText += delta;
      if (receivedText === chunks.join("")) {
        await pipeline.flush({ force: true });
        beforeEnd.resolve();
      }
    });
    const settled = Promise.all([producing, running]);
    try {
      await awaitGateBeforeSettlement(
        beforeEnd.promise,
        settled,
        "transport ended before the pre-terminal checkpoint",
      );
      expect(delivered.length).toBeGreaterThan(0);
      const beforeTerminalCount = delivered.length;
      if ("terminalText" in scenario) {
        expect(texts(delivered).join("\n")).toBe(
          scenario.chunks.map((text) => text.trimEnd()).join("\n"),
        );
      }
      const text = texts(delivered).join("");
      if ("preservedLiteral" in scenario) {
        expect(text).toContain(scenario.preservedLiteral);
      }
      if ("literal" in scenario) {
        expect.soft(text).toContain(scenario.marker);
        if ("literalText" in scenario) {
          expect
            .soft(delivered.find((payload) => payload.text?.includes(scenario.marker))?.text)
            .toBe(scenario.literalText);
        }
      } else {
        expect.soft(text).not.toContain(scenario.marker);
      }
      if ("replyToId" in scenario) {
        const targets = delivered.filter((payload) => payload.replyToId);
        expect.soft(targets.map((payload) => payload.replyToId)).toContain(scenario.replyToId);
        for (const payload of targets) {
          expect.soft(payload.replyToId).toBe(scenario.replyToId);
          expect.soft(Boolean(payload.replyToTag)).toBe(true);
        }
      } else {
        expect.soft(delivered.every(hasNoReplyTarget)).toBe(true);
      }
      expect
        .soft(delivered.filter((payload) => payload.audioAsVoice && payload.text).length)
        .toBe("voiceEdges" in scenario ? scenario.voiceEdges : 0);
      if ("textOnly" in scenario) {
        expect(delivered.every(hasNoMedia)).toBe(true);
      }
      releaseTerminal.resolve();
      await settled;
      await flush();
      if ("terminalText" in scenario) {
        const recipientText = texts(delivered);
        const additional = recipientText.slice(beforeTerminalCount);
        expect(additional.join(" ")).toBe(scenario.correctedText);
        for (const sentence of scenario.unchangedLeadSentences) {
          expect.soft(recipientText.join(" ").split(sentence)).toHaveLength(2);
        }
      }
      if ("textOnly" in scenario) {
        expect(delivered.every(hasNoMedia)).toBe(true);
      }
      if (hasAudio) {
        const audio = delivered.filter(isAudioPayload);
        expect(audio).toHaveLength(1);
        expect(audio[0]?.mediaUrls).toEqual([audioUrl]);
        expect(Boolean(audio[0]?.audioAsVoice)).toBe(scenario.audioAsVoice);
      }
    } finally {
      releaseTerminal.resolve();
      await Promise.allSettled([producing, running]);
    }
  },
);

it("does not replay signed Google text when a later part shares its signature", async () => {
  const { delivered, pipeline, emit, subscription, flush } = createDeliveryHarness();
  const first = "Alpha  beta.\n";
  const signature = "c2lnXzE=";
  const firstDelivered = createDeferred();
  let firstCheckpoint = "";
  async function* googleEvents() {
    const part = (text: string) => ({ text, thoughtSignature: signature });
    yield googleChunk([part(first)]);
    await firstDelivered.promise;
    yield googleChunk([part("[[reply_to_current]]"), part("Second.\n")], "STOP");
  }
  const { response, producing } = googleResponse(googleEvents(), "sdk");
  const running = runDeliveryLoop({ emit, subscription }, googleModel, response, async (delta) => {
    if (delta === first) {
      await pipeline.flush({ force: true });
      firstCheckpoint = texts(delivered).join("");
      firstDelivered.resolve();
    }
  });
  try {
    await Promise.all([producing, running]);
    await flush();
    expect(firstCheckpoint).toBe("Alpha  beta.");
    const text = texts(delivered).join(" ").replace(/\s+/g, " ").trim();
    expect(text).toBe("Alpha beta. Second.");
  } finally {
    firstDelivered.resolve();
    await Promise.allSettled([producing, running]);
  }
});

it("holds a partial MEDIA prefix through ordinary word completion", async () => {
  const prefix = "x".repeat(48);
  const { delivered, blocks, emit, flush } = createDeliveryHarness({ minChars: 50 });
  let text = `${prefix}\nM`;
  emit({ type: "message_start", message: createAssistantOutput(googleModel) });
  emitText(emit, "text_delta", text);
  await flush();
  expect.soft({ blocks, delivered }).toEqual({ blocks: [], delivered: [] });

  for (const delta of ["e", "tal"]) {
    text += delta;
    emitText(emit, "text_delta", text, { delta });
  }
  emitText(emit, "text_end", text);
  emit({ type: "message_end", message: textMessage(text) });
  await flush();
  expect.soft(texts(delivered).join("")).toBe(`${prefix}\nMetal`);
  expect.soft(delivered.flatMap((payload) => payload.mediaUrls ?? [])).toEqual([]);
});

it.each(["literal", "voice", "token"] as const)(
  "preserves terminal voice semantics for %s",
  async (kind) => {
    const { delivered, blocks, emit, flush } = createDeliveryHarness({
      blockReplyBreak: "message_end",
    });
    const marker = "[[audio_as_voice]]";
    const parts =
      kind === "literal"
        ? ["Use `" + "x".repeat(60), ` ${marker}\` literally.`]
        : [marker + (kind === "token" ? "NO_REPLY" : "")];
    emit({ type: "message_start", message: createAssistantOutput(googleModel) });
    emit({ type: "message_end", message: textMessage(parts) });
    await flush();
    if (kind === "literal") {
      const text = texts(delivered).join("");
      expect.soft(text).toContain(marker);
      expect.soft(text.split(marker)).toHaveLength(2);
      for (const payload of [...blocks, ...delivered]) {
        expect.soft(Boolean(payload.audioAsVoice)).toBe(false);
        expect.soft(payload.replyToId).toBeUndefined();
        expect.soft(Boolean(payload.replyToCurrent || payload.replyToTag)).toBe(false);
      }
    } else {
      expect(
        blocks.map((payload) => ({
          text: payload.text,
          audioAsVoice: payload.audioAsVoice === true,
          silentReply: getReplyPayloadMetadata(payload)?.silentReply,
        })),
      ).toEqual([
        { text: kind === "token" ? "NO_REPLY" : "", audioAsVoice: true, silentReply: undefined },
      ]);
    }
  },
);

it("applies a directive-only text_end to already-buffered audio", async () => {
  const { delivered, handler, emit, flush } = createDeliveryHarness();
  await handler({ mediaUrls: [audioUrl] });
  emit({ type: "message_start", message: { role: "assistant" } });
  emitAssistantTextDelta({ emit, delta: "[[audio_as_voice]]" });
  emitAssistantTextEnd({ emit });
  await flush();
  expect(delivered.filter(isAudioPayload)).toEqual([
    expect.objectContaining({ mediaUrls: [audioUrl], audioAsVoice: true }),
  ]);
  expect(delivered.some((payload) => payload.text)).toBe(false);
});

const first = "[[audio_as_voice]]First reply.\n\n" + nextParagraph;
const corrected =
  first + "The corrected tail is long enough to flush after the committed prefix.\n\n";
it.each([
  {
    name: "literal reclassification and restored authoritative text",
    expectedReplies: ["First reply."],
    updates: [
      ["text_delta", first, 0, 1],
      ["text_end", "```text\n" + corrected + "```\n\n", 0, 1],
      ["text_end", corrected + nextParagraph, 0, 2],
    ],
  },
  {
    name: "a new item owns its own genuine voice intent",
    expectedReplies: ["First reply.", "Second reply."],
    updates: [
      ["text_delta", first, 0, 1],
      ["text_delta", "[[audio_as_voice]]Second reply.\n\n" + nextParagraph, 1, 2],
    ],
  },
] as const)("preserves $name", async ({ updates, expectedReplies }) => {
  const { delivered, blocks, handler, emit, flush } = createDeliveryHarness();
  await handler({ mediaUrls: [audioUrl] });
  emit({ type: "message_start", message: textMessage("", 0) });
  for (const [type, text, item, edges] of updates) {
    emitText(emit, type, text, { item });
    await flush();
    expect.soft(blocks.filter((payload) => payload.audioAsVoice)).toHaveLength(edges);
  }
  for (const text of expectedReplies) {
    expect(delivered.filter((payload) => payload.text === text)).toHaveLength(1);
  }
  expect(delivered.filter(isAudioPayload).map((payload) => payload.audioAsVoice)).toEqual([true]);
});

it("keeps generic directive URLs separate from tool-owned managed media", () => {
  const state = {
    pendingToolMediaTrustByUrl: new Map([
      ["./managed.png", true],
      ["./ordinary.png", false],
    ]),
  };

  expect(
    resolveManagedStreamMediaUrls(state, ["./ordinary.png", "./managed.png", "./unknown.png"]),
  ).toEqual(["./managed.png"]);
});

it("retains raw XML projection across a source replacement", () => {
  const xmlText = "<tool_call>{}</tool_call>Visible\n";
  const resolve = createStreamingReplyResolver();
  let previousCleaned = "";
  for (const frame of [
    { text: "Discarded.", delta: "Discarded.", expected: "Discarded." },
    { text: xmlText, expected: "Visible" },
    { text: xmlText + "tail", delta: "tail", expected: "Visible\ntail" },
  ]) {
    const delta = "delta" in frame ? frame.delta : undefined;
    const result = resolve({
      evtType: "text_delta",
      next: frame.text,
      previousText: "",
      previousCleaned,
      visibleDelta: delta ?? frame.text,
      appendDelta: delta ?? null,
      parsedStreamDirectives: { text: "", replyToTag: false },
      previousAudioDirectiveCount: 0,
      rawDirectiveSource: frame.text,
      rawDirectiveDelta: delta,
    });
    expect(result.text).toBe(frame.expected);
    previousCleaned = result.text;
  }
});
it.each([
  ["", `before${"\n".repeat(60_000)}after`],
  ...["\r", "\n", "\r\n"].flatMap((eol) =>
    ["", "M", "ME", "MED", "MEDI", "MEDIA"].map((marker) => [
      "MEDIA: ./a.png\nCaption",
      marker ? `${eol}${marker}` : `${eol}MEDIA: ./b.png${eol}After`,
      marker ? `${"MEDIA".slice(marker.length)}: ./b.png${eol}After` : "",
    ]),
  ),
])("keeps media boundaries and long blank runs canonical: %j", (...chunks: string[]) => {
  const resolve = createStreamingReplyResolver();
  let previousText = "";
  let previousCleaned = "";
  const started = performance.now();
  for (const visibleDelta of chunks.filter(Boolean)) {
    const next = previousText + visibleDelta;
    const result = resolve({
      evtType: "text_delta",
      next,
      previousText,
      previousCleaned,
      visibleDelta,
      appendDelta: visibleDelta,
      parsedStreamDirectives: { text: visibleDelta, replyToTag: false },
      previousAudioDirectiveCount: 0,
    });
    previousText = next;
    previousCleaned = result.text;
  }
  expect(previousCleaned).toBe(parseReplyDirectives(chunks.join("")).text);
  expect(performance.now() - started).toBeLessThan(1_000);
});
it("streams a long reply-tagged answer without a quadratic slowdown", () => {
  const body = `${"Paragraph with `code` and **bold** text.\n\n- item `one`\n- item two\n\n".repeat(100)}\`\`\`ts\nconst x = 1;\n\`\`\`\n\nDone.`;
  const text = `[[reply_to_current]] Intro.\n\n${body}`;
  const partials: ReplyPayload[] = [];
  const { emit } = createSubscribedSessionHarness({
    runId: "run-tagged-stream",
    onPartialReply: (payload) => void partials.push(payload),
  });
  emit({ type: "message_start", message: textMessage("") });
  const started = performance.now();
  for (let end = 40; end - 40 < text.length; end += 40) {
    emitText(emit, "text_delta", text.slice(0, end), { delta: text.slice(end - 40, end) });
  }
  emitText(emit, "text_end", text);
  expect(performance.now() - started).toBeLessThan(1_000);
  expect(partials.at(-1)?.text).toBe(`Intro.\n\n${body}`);
});
