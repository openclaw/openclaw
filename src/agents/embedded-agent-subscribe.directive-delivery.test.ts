import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
import { expect, it, onTestFinished } from "vitest";
import { consumeGoogleGenerateContentStream } from "../../packages/ai/src/providers/google-stream.js";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { createAssistantOutput } from "../../packages/ai/src/transports/assistant-output.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { markdownToIR } from "../../packages/markdown-core/src/ir.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { isAudioPayload } from "../auto-reply/reply/agent-runner-helpers.js";
import { createBlockReplyPipeline } from "../auto-reply/reply/block-reply-pipeline.js";
import { createBlockReplyDeliveryHandler } from "../auto-reply/reply/reply-delivery.js";
import { createReplyToModeFilterForChannel } from "../auto-reply/reply/reply-threading.js";
import { createTypingSignaler } from "../auto-reply/reply/typing-mode.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  blockDirectiveCases,
  settledParagraph,
} from "./embedded-agent-subscribe.directive-delivery.block-code.test-support.js";
import { inlineDirectiveCases } from "./embedded-agent-subscribe.directive-delivery.inline-code.test-support.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  resolveManagedStreamMediaUrls,
} from "./embedded-agent-subscribe.handlers.messages.replies.js";
import { resolveStreamingReply } from "./embedded-agent-subscribe.handlers.messages.stream.js";

const googleModel: Model<"google-generative-ai"> = {
  id: "gemini-2.5-flash",
  name: "Gemini 2.5 Flash",
  api: "google-generative-ai",
  provider: "google",
  baseUrl: "https://example.invalid",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};
const responsesModel: Model<"openai-responses"> = {
  ...googleModel,
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "openai-responses",
  provider: "openai",
};
const audioUrl = "https://example.invalid/clip.ogg";
const nextParagraph = "A second paragraph gives the completed example enough text to drain.\n\n";

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
    typingSignals: createTypingSignaler({ typing, mode: "never", isHeartbeat: false }),
    blockStreamingEnabled: true,
    blockReplyPipeline: pipeline,
    directBlockDeliveries: [],
  });
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run-directive-delivery",
    onBlockReply: (payload) => {
      blocks.push(structuredClone(payload));
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
          (message): message is Message =>
            message.role === "user" ||
            message.role === "assistant" ||
            message.role === "toolResult",
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

const cases = [
  ...blockDirectiveCases,
  ...inlineDirectiveCases,
  {
    name: "authored indented code after a drained paragraph",
    chunks: ["Intro.\n\n", "    const value = 1;\n    use(value);\n\n"],
    marker: "const value = 1;\nuse(value);",
    literal: true,
    code: true,
  },
  {
    name: "late voice intent for already-buffered audio",
    chunks: ["[[audio_as_", "voice]]Visible reply.\n\n"],
    marker: "[[audio_as_voice]]",
    audioAsVoice: true,
    voiceEdges: 1,
    bufferAudioFirst: true,
  },
  {
    name: "genuine voice intent after a held media line",
    prepared: true,
    chunks: [
      "[[audio_as_voice]]First voice reply.\n\n" + nextParagraph,
      `MEDIA:${audioUrl}`,
      "\n[[audio_as_voice]]Second voice reply.\n\n",
    ],
    marker: "[[audio_as_voice]]",
    audioAsVoice: true,
    voiceEdges: 2,
    mediaInChunks: true,
  },
] as const;

const rawDirectiveCases = [
  {
    name: "full-context reply interpretation after a later reference definition",
    chunks: [
      "![`[[reply_to:reference-id]]`][example]\n\n" + settledParagraph,
      "Continue before the reference definition.\n\n",
      "[example]: #example\n\n",
      "Continue after the reference definition.\n\n",
    ],
    marker: "[[reply_to:reference-id]]",
    literal: true,
    replyToId: "reference-id",
    textOnly: true,
  },
] as const;

const replacementChunks = [
  "The current value is one for this item. Continue. ",
  "Keep this sentence unchanged. Retain each result. ",
  "The final summary also remains unchanged.\n",
] as const;
const prefixCorrectionCases = [
  { value: "two", leadChunks: [] },
  { value: "thirty-three", leadChunks: ["First lead stays.\n", "Next lead stays.\n"] },
].map(({ value, leadChunks }) => ({
  name: `authoritative prefix correction ${leadChunks.length ? "with early chunks" : value}`,
  chunks: [...leadChunks, ...replacementChunks],
  marker: "Keep this sentence unchanged.",
  unchangedLeadSentences: leadChunks.map((text) => text.trimEnd()),
  literal: true,
  prefixCorrection: true,
  prepared: true,
  terminalText:
    leadChunks.join("") +
    replacementChunks[0].replace("one", value) +
    replacementChunks.slice(1).join(""),
  correctedStatement: `The current value is ${value} for this item.`,
  expectedAdditional:
    value === "two" ? [replacementChunks[0].replace("one", value).trimEnd()] : undefined,
}));

it.each([...cases, ...rawDirectiveCases, ...prefixCorrectionCases])(
  "preserves $name through the delivery handler",
  async (scenario) => {
    const route = "prepared" in scenario ? "responses prepared" : "google raw";
    const { delivered, pipeline, handler, emit, subscription } = createDeliveryHarness();
    const hasAudio = "audioAsVoice" in scenario;
    const bufferAudioFirst = "bufferAudioFirst" in scenario;
    if (bufferAudioFirst) {
      await handler({ mediaUrls: [audioUrl] });
      expect(pipeline.hasBuffered()).toBe(true);
    }
    const chunks = [
      ...scenario.chunks,
      ...("prefixCorrection" in scenario ? [] : [nextParagraph]),
      ...(hasAudio && !bufferAudioFirst && !("mediaInChunks" in scenario)
        ? [`MEDIA:${audioUrl}`]
        : []),
    ];
    const expectCodeContent = () => {
      if (!("code" in scenario)) {
        return;
      }
      const codeBlocks = delivered.flatMap((payload) => {
        const ir = markdownToIR(payload.text ?? "");
        return ir.styles
          .filter((span) => span.style === "code_block")
          .map((span) => ir.text.slice(span.start, span.end));
      });
      expect.soft(codeBlocks).toEqual([`${scenario.marker}\n`]);
    };
    const beforeEnd = createDeferred();
    const releaseTerminal = createDeferred();
    const response = new AssistantMessageEventStream();
    const model = route === "google raw" ? googleModel : responsesModel;
    const output =
      route === "google raw"
        ? createAssistantOutput(googleModel)
        : createResponsesAssistantOutput(responsesModel);
    async function* googleEvents() {
      for (const text of chunks) {
        yield { candidates: [{ content: { parts: [{ text }] } }] };
      }
      await releaseTerminal.promise;
      yield { candidates: [{ finishReason: "STOP" }] };
    }
    async function* responsesEvents() {
      yield {
        type: "response.output_item.added",
        output_index: 0,
        item: {
          type: "message",
          id: "answer",
          role: "assistant",
          phase: "final_answer",
          content: [],
        },
      };
      for (const delta of chunks) {
        yield { type: "response.output_text.delta", output_index: 0, delta };
      }
      await releaseTerminal.promise;
      yield {
        type: "response.completed",
        response: {
          id: "response",
          status: "completed",
          output: [
            {
              type: "message",
              id: "answer",
              role: "assistant",
              phase: "final_answer",
              status: "completed",
              content: [
                {
                  type: "output_text",
                  text: "terminalText" in scenario ? scenario.terminalText : chunks.join(""),
                  annotations: [],
                },
              ],
            },
          ],
        },
      };
    }
    if (route === "responses prepared") {
      response.push({ type: "start", partial: output });
    }
    const producing =
      route === "google raw"
        ? consumeGoogleGenerateContentStream({
            chunks: googleEvents(),
            model: googleModel,
            output,
            stream: response,
            profile: "managed",
            nextToolCallId: () => "unused-tool",
          })
        : processResponsesStream(responsesEvents(), output, response, responsesModel).then(() => {
            response.push({ type: "done", reason: "stop", message: output });
            response.end();
          });
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
      await Promise.race([
        beforeEnd.promise,
        settled.then(() => {
          throw new Error("transport ended before the pre-terminal checkpoint");
        }),
      ]);
      expect(delivered.length).toBeGreaterThan(0);
      const beforeTerminalCount = delivered.length;
      if ("prefixCorrection" in scenario) {
        expect(delivered.map((payload) => payload.text).join("\n")).toBe(
          scenario.chunks.map((text) => text.trimEnd()).join("\n"),
        );
      }
      const text = delivered.map((payload) => payload.text ?? "").join("");
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
        expect
          .soft(
            delivered.filter((payload) => payload.replyToId).map((payload) => payload.replyToId),
          )
          .toContain(scenario.replyToId);
        expect
          .soft(
            delivered.every(
              (payload) =>
                !payload.replyToId ||
                (payload.replyToId === scenario.replyToId && payload.replyToTag),
            ),
          )
          .toBe(true);
      } else {
        expect
          .soft(
            delivered.every(
              (payload) => !payload.replyToId && !payload.replyToCurrent && !payload.replyToTag,
            ),
          )
          .toBe(true);
      }
      expect
        .soft(delivered.filter((payload) => payload.audioAsVoice && payload.text).length)
        .toBe("voiceEdges" in scenario ? scenario.voiceEdges : 0);
      if ("textOnly" in scenario) {
        expect(delivered.every((payload) => !payload.mediaUrl && !payload.mediaUrls?.length)).toBe(
          true,
        );
      }
      expectCodeContent();
      releaseTerminal.resolve();
      await settled;
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      if ("prefixCorrection" in scenario) {
        const recipientText = delivered.map((payload) => payload.text ?? "");
        const additional = recipientText.slice(beforeTerminalCount);
        if (scenario.expectedAdditional !== undefined) {
          expect(additional).toEqual(scenario.expectedAdditional);
        }
        if (scenario.correctedStatement) {
          expect(additional.join(" ")).toContain(scenario.correctedStatement);
        }
        expect(recipientText.join(" ").split(scenario.marker)).toHaveLength(2);
        for (const sentence of scenario.unchangedLeadSentences) {
          expect.soft(recipientText.join(" ").split(sentence)).toHaveLength(2);
        }
      }
      if ("textOnly" in scenario) {
        expect(delivered.every((payload) => !payload.mediaUrl && !payload.mediaUrls?.length)).toBe(
          true,
        );
      }
      expectCodeContent();
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
  const { delivered, pipeline, emit, subscription } = createDeliveryHarness();
  const first = "Alpha  beta.\n";
  const signature = "c2lnXzE=";
  const firstDelivered = createDeferred();
  let firstCheckpoint = "";
  const response = new AssistantMessageEventStream();
  const output = createAssistantOutput(googleModel);
  async function* googleEvents() {
    yield {
      candidates: [{ content: { parts: [{ text: first, thoughtSignature: signature }] } }],
    };
    await firstDelivered.promise;
    yield {
      candidates: [
        {
          content: {
            parts: [
              { text: "[[reply_to_current]]", thoughtSignature: signature },
              { text: "Second.\n", thoughtSignature: signature },
            ],
          },
          finishReason: "STOP",
        },
      ],
    };
  }
  const producing = consumeGoogleGenerateContentStream({
    chunks: googleEvents(),
    model: googleModel,
    output,
    stream: response,
    profile: "sdk",
    nextToolCallId: () => "unused-tool",
  });
  const running = runDeliveryLoop({ emit, subscription }, googleModel, response, async (delta) => {
    if (delta === first) {
      await pipeline.flush({ force: true });
      firstCheckpoint = delivered.map((payload) => payload.text ?? "").join("");
      firstDelivered.resolve();
    }
  });
  try {
    await Promise.all([producing, running]);
    await subscription.waitForPendingEvents();
    await pipeline.flush({ force: true });

    expect(firstCheckpoint).toBe("Alpha  beta.");
    const text = delivered
      .map((payload) => payload.text ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    expect(text).toBe("Alpha beta. Second.");
  } finally {
    firstDelivered.resolve();
    await Promise.allSettled([producing, running]);
  }
});

const prefix = "x".repeat(48);
it.each([
  {
    name: "ordinary word completion",
    initialText: `${prefix}\nM`,
    deltas: ["e", "tal"],
    expectedText: `${prefix}\nMetal`,
    expectedMedia: [],
  },
  {
    name: "a tab-indented paragraph continuation",
    initialText: "Preview:\n\tM",
    deltas: ["EDIA:./asset.png"],
    expectedText: "Preview:",
    expectedMedia: ["./asset.png"],
  },
])("holds a partial MEDIA prefix through $name", async (scenario) => {
  const { delivered, blocks, emit, flush } = createDeliveryHarness({
    minChars: 50,
  });
  let text = scenario.initialText;
  emit({ type: "message_start", message: createAssistantOutput(googleModel) });
  emitText(emit, "text_delta", text);
  await flush();
  expect.soft(blocks).toEqual([]);
  expect.soft(delivered).toEqual([]);

  for (const delta of scenario.deltas) {
    text += delta;
    emitText(emit, "text_delta", text, { delta });
  }
  emitText(emit, "text_end", text);
  emit({ type: "message_end", message: textMessage(text) });
  await flush();
  expect.soft(delivered.map((payload) => payload.text ?? "").join("")).toBe(scenario.expectedText);
  expect
    .soft(delivered.flatMap((payload) => payload.mediaUrls ?? []))
    .toEqual(scenario.expectedMedia);
});

it("preserves a native-part voice literal through terminal delivery", async () => {
  const { delivered, blocks, emit, flush } = createDeliveryHarness({
    blockReplyBreak: "message_end",
  });
  const marker = "[[audio_as_voice]]";
  const parts = ["Use `" + "x".repeat(60), ` ${marker}\` literally.`];
  emit({ type: "message_start", message: createAssistantOutput(googleModel) });
  emit({
    type: "message_end",
    message: textMessage(parts),
  });
  await flush();
  const text = delivered.map((payload) => payload.text ?? "").join("");
  expect.soft(text).toContain(marker);
  expect.soft(text.split(marker)).toHaveLength(2);
  for (const payload of [...blocks, ...delivered]) {
    expect.soft(Boolean(payload.audioAsVoice)).toBe(false);
    expect.soft(payload.replyToId).toBeUndefined();
    expect.soft(Boolean(payload.replyToCurrent || payload.replyToTag)).toBe(false);
  }
});

it.each([false, true])("carries terminal voice intent with silent=%s", async (silent) => {
  const blocks: ReplyPayload[] = [];
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "run-terminal-silence",
    onBlockReply: (payload) => {
      blocks.push(payload);
    },
    blockReplyBreak: "message_end",
  });
  onTestFinished(() => subscription.unsubscribe());
  emit({ type: "message_start", message: createAssistantOutput(googleModel) });
  emit({
    type: "message_end",
    message: textMessage("[[audio_as_voice]]" + (silent ? "NO_REPLY" : "")),
  });
  await subscription.waitForPendingEvents();

  expect(
    blocks.map((payload) => ({
      text: payload.text,
      audioAsVoice: payload.audioAsVoice === true,
      silentReply: getReplyPayloadMetadata(payload)?.silentReply,
    })),
  ).toEqual([
    {
      text: "",
      audioAsVoice: true,
      silentReply: silent ? true : undefined,
    },
  ]);
});

it("applies a directive-only text_end to already-buffered audio", async () => {
  const { delivered, pipeline, handler, emit, subscription } = createDeliveryHarness();
  await handler({ mediaUrls: [audioUrl] });
  emit({ type: "message_start", message: { role: "assistant" } });
  emitAssistantTextDelta({ emit, delta: "[[audio_as_voice]]" });
  emitAssistantTextEnd({ emit });
  await subscription.waitForPendingEvents();
  await pipeline.flush({ force: true });

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
      { type: "text_delta", text: first, item: 0, edges: 1 },
      { type: "text_end", text: "```text\n" + corrected + "```\n\n", item: 0, edges: 1 },
      { type: "text_end", text: corrected + nextParagraph, item: 0, edges: 2 },
    ],
  },
  {
    name: "a new item owns its own genuine voice intent",
    expectedReplies: ["First reply.", "Second reply."],
    updates: [
      { type: "text_delta", text: first, item: 0, edges: 1 },
      {
        type: "text_delta",
        text: "[[audio_as_voice]]Second reply.\n\n" + nextParagraph,
        item: 1,
        edges: 2,
      },
    ],
  },
] as const)("preserves $name", async ({ updates, expectedReplies }) => {
  const { delivered, blocks, handler, emit, flush } = createDeliveryHarness();
  await handler({ mediaUrls: [audioUrl] });
  emit({ type: "message_start", message: textMessage("", 0) });
  for (const update of updates) {
    emitText(emit, update.type, update.text, { item: update.item });
    await flush();
    expect.soft(blocks.filter((payload) => payload.audioAsVoice)).toHaveLength(update.edges);
  }
  for (const text of expectedReplies) {
    expect(delivered.filter((payload) => payload.text === text)).toHaveLength(1);
  }
  const audio = delivered.filter(isAudioPayload);
  expect(audio).toHaveLength(1);
  expect(audio[0]?.audioAsVoice).toBe(true);
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

it("does not consume pending directive metadata on reasoning replies", () => {
  const state = {
    pendingAssistantReplyDirectives: {
      replyToId: "parent-message",
    },
  };

  expect(
    consumePendingAssistantReplyDirectivesIntoReply(state, {
      text: "Thinking...",
      isReasoning: true,
    }),
  ).toEqual({
    text: "Thinking...",
    isReasoning: true,
  });
  expect(state.pendingAssistantReplyDirectives?.replyToId).toBe("parent-message");
});

it("appends visible text across long blank runs without stalling the media scan", () => {
  const delta = `before${"\n".repeat(60_000)}after`;
  const started = performance.now();
  expect(
    resolveStreamingReply({
      evtType: "text_delta",
      next: delta,
      previousText: "",
      previousCleaned: "",
      visibleDelta: delta,
      appendDelta: delta,
      parsedStreamDirectives: { text: delta, replyToTag: false, isSilent: false },
      previousAudioDirectiveCount: 0,
    }),
  ).toEqual({
    text: delta,
    delta,
    replace: false,
    hasText: true,
    replyDirectives: { text: delta, replyToTag: false, isSilent: false },
    audioDirectiveCount: 0,
  });
  expect(performance.now() - started).toBeLessThan(1_000);
});
