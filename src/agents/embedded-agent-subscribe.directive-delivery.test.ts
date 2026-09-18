import { AssistantMessageEventStream, type Message, type Model } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { consumeGoogleGenerateContentStream } from "../../packages/ai/src/providers/google-stream.js";
import { createResponsesAssistantOutput } from "../../packages/ai/src/providers/openai-responses-shared.js";
import { createAssistantOutput } from "../../packages/ai/src/transports/assistant-output.js";
import { processResponsesStream } from "../../packages/ai/src/transports/openai-responses-stream-internal.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { getReplyPayloadMetadata } from "../auto-reply/reply-payload.js";
import { isAudioPayload } from "../auto-reply/reply/agent-runner-helpers.js";
import {
  createAudioAsVoiceBuffer,
  createBlockReplyPipeline,
} from "../auto-reply/reply/block-reply-pipeline.js";
import { createBlockReplyDeliveryHandler } from "../auto-reply/reply/reply-delivery.js";
import { createReplyToModeFilterForChannel } from "../auto-reply/reply/reply-threading.js";
import { createTypingSignaler } from "../auto-reply/reply/typing-mode.js";
import { createTypingController } from "../auto-reply/reply/typing.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { runAgentLoop } from "../plugin-sdk/agent-core.js";
import { sanitizeUserFacingText } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextEnd,
} from "./embedded-agent-subscribe.e2e-harness.js";
import {
  consumePendingAssistantReplyDirectivesIntoReply,
  hasAssistantVisibleReply,
  recordPendingAssistantReplyDirectives,
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
const settledParagraph = "Another paragraph is visible before the next streaming update.\n\n";

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
    buffer: createAudioAsVoiceBuffer({ isAudioPayload }),
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
    directlySentBlockKeys: new Set(),
    directBlockDeliveries: [],
  });
  return {
    delivered,
    blocks,
    pipeline,
    typing,
    handler,
    ...createSubscribedSessionHarness({
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
    }),
  };
}

const cases = [
  {
    name: "ordinary continuations after a settled literal in a later paragraph",
    chunks: [
      "Introductory text is ordinary prose.\n\n",
      "Use `[[reply_to:example-id]]` literally.\n\n" + settledParagraph,
      "Keep the remaining explanation in order.\n\n",
    ],
    marker: "[[reply_to:example-id]]",
    literal: true,
    ordinary: true,
  },
  {
    name: "a later split literal after an already settled literal",
    chunks: [
      "Use `[[reply_to:example-id]]` literally.\n\n" + settledParagraph,
      "Keep this ordinary continuation.\n\n",
      "Another `",
      "[",
      "[reply_to:example-id]]",
      "` example remains literal.\n\n",
    ],
    marker: "[[reply_to:example-id]]",
    literal: true,
    ordinary: true,
  },
  {
    name: "a genuine reply directive after a settled literal",
    chunks: [
      "Use `[[reply_to:example-id]]` literally.\n\n" + settledParagraph,
      "Continue with ordinary prose.\n\n",
      "[[reply_to:",
      "later-id]]Continue after reply intent.\n\n",
      "Keep this later continuation in order.\n\n",
    ],
    marker: "[[reply_to:later-id]]",
    replyToId: "later-id",
    textOnly: true,
  },
  {
    name: "ordinary continuations after array access",
    chunks: [
      "Use items[0] as the first value.\n\n",
      "Keep the remaining values in order.\n\n",
      "Continue with the next value.\n\n",
    ],
    marker: "items[0]",
    literal: true,
    ordinary: true,
  },
  {
    name: "ordinary continuations after a Markdown link",
    chunks: [
      "Read [guide](https://example.invalid).\n\n",
      "Follow the steps in their listed order.\n\n",
      "The final step completes the setup.\n\n",
    ],
    marker: "[guide](https://example.invalid)",
    literal: true,
    ordinary: true,
  },
  {
    name: "ordinary continuations after an angle bracket",
    chunks: [
      "Stop when value < limit.\n\n",
      "Otherwise keep the current value.\n\n",
      "Continue until the comparison is satisfied.\n\n",
    ],
    marker: "value < limit",
    literal: true,
    ordinary: true,
  },
  {
    name: "reply marker in split inline code",
    chunks: ["Use `" + "x".repeat(60), "[[reply_to:example-id]]` literally.\n\n"],
    marker: "[[reply_to:example-id]]",
    literal: true,
  },
  {
    name: "genuine split reply directive",
    chunks: ["[[reply_to:", "example-id]]Visible reply.\n\n"],
    marker: "[[reply_to:example-id]]",
    replyToId: "example-id",
  },
  {
    name: "reply marker in a fenced example",
    chunks: ["```text\n", "[[reply_to:example-id]]\n```\n\n"],
    marker: "[[reply_to:example-id]]",
    literal: true,
  },
  {
    name: "authored indented code after a drained paragraph",
    chunks: ["Intro.\n\n", "    const value = 1;\n    use(value);\n\n"],
    marker: "    const value = 1;\n    use(value);",
    literal: true,
  },
  {
    name: "voice marker split from its inline opener",
    chunks: ["Use `", "[[audio_as_voice]]` literally.\n\n"],
    marker: "[[audio_as_voice]]",
    literal: true,
    audioAsVoice: false,
  },
  {
    name: "voice marker in physically split inline code",
    chunks: ["Use `" + "x".repeat(60), "[[audio_as_voice]]` literally.\n\n"],
    marker: "[[audio_as_voice]]",
    literal: true,
    audioAsVoice: false,
  },
  {
    name: "genuine split voice directive",
    chunks: ["[[audio_as_", "voice]]Visible reply.\n\n"],
    marker: "[[audio_as_voice]]",
    audioAsVoice: true,
    voiceEdges: 1,
  },
  {
    name: "a voice literal after earlier genuine voice intent",
    chunks: [
      "[[audio_as_voice]]Voice reply.\n\n" + nextParagraph,
      "Use `",
      "[[audio_as_voice]]` literally.\n\n",
    ],
    marker: "[[audio_as_voice]]",
    literal: true,
    audioAsVoice: true,
    voiceEdges: 1,
  },
  {
    name: "two genuine voice directives",
    chunks: [
      "[[audio_as_voice]]First voice reply.\n\n" + nextParagraph,
      "[[audio_as_",
      "voice]]Second voice reply.\n\n",
    ],
    marker: "[[audio_as_voice]]",
    audioAsVoice: true,
    voiceEdges: 2,
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
  ...["one", "two", "thirty-three"].map((value) => ({ value, leadChunks: [] })),
  { value: "thirty-three", leadChunks: ["First lead stays.\n", "Next lead stays.\n"] },
].map(({ value, leadChunks }) => ({
  name: `authoritative prefix correction ${leadChunks.length ? "with early chunks" : value}`,
  chunks: [...leadChunks, ...replacementChunks],
  marker: "Keep this sentence unchanged.",
  unchangedLeadSentences: leadChunks.map((text) => text.trimEnd()),
  literal: true,
  prefixCorrection: true,
  terminalText:
    leadChunks.join("") +
    replacementChunks[0].replace("one", value) +
    replacementChunks.slice(1).join(""),
  correctedStatement: value === "one" ? undefined : `The current value is ${value} for this item.`,
  expectedAdditional:
    value === "one"
      ? []
      : value === "two"
        ? [replacementChunks[0].replace("one", value).trimEnd()]
        : undefined,
}));

describe.each(["google raw", "responses prepared"] as const)("%s directive delivery", (route) => {
  it.each([
    ...cases,
    ...(route === "responses prepared" ? prefixCorrectionCases : rawDirectiveCases),
  ])("preserves $name through the delivery handler", async (scenario) => {
    const { delivered, pipeline, typing, handler, emit, subscription } = createDeliveryHarness();
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
    const expectOrdinaryContent = (phase: "streaming" | "final") => {
      if (!("ordinary" in scenario)) {
        return;
      }
      const text = delivered
        .map((payload) => payload.text ?? "")
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      const expected = chunks.join("").replace(/\s+/g, " ").trim();
      if (phase === "final") {
        expect(text).toBe(expected);
      } else {
        const completed = scenario.chunks.join("").replace(/\s+/g, " ").trim();
        expect(text.slice(0, completed.length)).toBe(completed);
        expect(text).toBe(expected.slice(0, text.length));
      }
      expect(delivered.every((payload) => !payload.mediaUrl && !payload.mediaUrls?.length)).toBe(
        true,
      );
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
    let deltas = 0;
    const running = runAgentLoop(
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
        emit(event);
        await subscription.waitForPendingEvents();
        if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
          deltas += 1;
          if (deltas === chunks.length) {
            await pipeline.flush({ force: true });
            beforeEnd.resolve();
          }
        }
      },
      undefined,
      () => response,
    );
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
        expect(delivered.map((payload) => payload.text)).toEqual(
          scenario.chunks.map((text) => text.trimEnd()),
        );
      }
      const text = delivered.map((payload) => payload.text ?? "").join("");
      if ("literal" in scenario) {
        expect.soft(text).toContain(scenario.marker);
      } else {
        expect.soft(text).not.toContain(scenario.marker);
      }
      if ("replyToId" in scenario) {
        expect
          .soft(
            delivered.some(
              (payload) => payload.replyToId === scenario.replyToId && payload.replyToTag,
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
      expectOrdinaryContent("streaming");
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
      expectOrdinaryContent("final");
      if (hasAudio) {
        const audio = delivered.filter(isAudioPayload);
        expect(audio).toHaveLength(1);
        expect(audio[0]?.mediaUrls).toEqual([audioUrl]);
        expect(Boolean(audio[0]?.audioAsVoice)).toBe(scenario.audioAsVoice);
      }
    } finally {
      releaseTerminal.resolve();
      await Promise.allSettled([producing, running]);
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      subscription.unsubscribe();
      pipeline.stop();
      typing.cleanup();
    }
  });
});

describe("signed Google part delivery", () => {
  it("does not replay signed Google text when a later part shares its signature", async () => {
    const { delivered, pipeline, typing, emit, subscription } = createDeliveryHarness();
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
    const running = runAgentLoop(
      [{ role: "user", content: "Write two ordinary sentences.", timestamp: 1 }],
      { systemPrompt: "", messages: [] },
      {
        model: googleModel,
        convertToLlm: (messages) =>
          messages.filter(
            (message): message is Message =>
              message.role === "user" ||
              message.role === "assistant" ||
              message.role === "toolResult",
          ),
      },
      async (event) => {
        emit(event);
        await subscription.waitForPendingEvents();
        if (
          event.type === "message_update" &&
          event.assistantMessageEvent.type === "text_delta" &&
          event.assistantMessageEvent.delta === first
        ) {
          await pipeline.flush({ force: true });
          firstCheckpoint = delivered.map((payload) => payload.text ?? "").join("");
          firstDelivered.resolve();
        }
      },
      undefined,
      () => response,
    );
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
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      subscription.unsubscribe();
      pipeline.stop();
      typing.cleanup();
    }
  });
});

describe("final prepared directive owners", () => {
  const prefix = "x".repeat(48);
  const imageUrl = "https://example.invalid/a.png";
  it.each([
    {
      name: "media completion",
      deltas: [`EDIA:${imageUrl}`],
      expectedText: prefix,
      expectedMedia: [imageUrl],
    },
    {
      name: "ordinary word completion",
      deltas: ["e", "tal"],
      expectedText: `${prefix}\nMetal`,
      expectedMedia: [],
    },
  ])("holds a partial MEDIA prefix through $name", async (scenario) => {
    const { delivered, blocks, pipeline, typing, emit, subscription } = createDeliveryHarness({
      minChars: 50,
    });
    let text = `${prefix}\nM`;
    const message = () => ({
      ...createAssistantOutput(googleModel),
      content: [{ type: "text", text }],
    });
    const emitDelta = (delta: string) => {
      const partial = message();
      emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta, partial },
      });
    };
    try {
      emit({ type: "message_start", message: createAssistantOutput(googleModel) });
      emitDelta(text);
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      expect.soft(blocks).toEqual([]);
      expect.soft(delivered).toEqual([]);

      for (const delta of scenario.deltas) {
        text += delta;
        emitDelta(delta);
      }
      const partial = message();
      emit({
        type: "message_update",
        message: partial,
        assistantMessageEvent: { type: "text_end", contentIndex: 0, content: text, partial },
      });
      emit({ type: "message_end", message: partial });
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      expect
        .soft(delivered.map((payload) => payload.text ?? "").join(""))
        .toBe(scenario.expectedText);
      expect
        .soft(delivered.flatMap((payload) => payload.mediaUrls ?? []))
        .toEqual(scenario.expectedMedia);
    } finally {
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      subscription.unsubscribe();
      pipeline.stop();
      typing.cleanup();
    }
  });

  it("preserves a native-part voice literal through terminal delivery", async () => {
    const { delivered, blocks, pipeline, typing, emit, subscription } = createDeliveryHarness({
      blockReplyBreak: "message_end",
    });
    const marker = "[[audio_as_voice]]";
    const parts = ["Use `" + "x".repeat(60), ` ${marker}\` literally.`];
    try {
      emit({ type: "message_start", message: createAssistantOutput(googleModel) });
      emit({
        type: "message_end",
        message: {
          ...createAssistantOutput(googleModel),
          content: parts.map((text) => ({ type: "text", text })),
        },
      });
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      const text = delivered.map((payload) => payload.text ?? "").join("");
      expect.soft(text).toContain(marker);
      expect.soft(text.split(marker)).toHaveLength(2);
      for (const payload of [...blocks, ...delivered]) {
        expect.soft(Boolean(payload.audioAsVoice)).toBe(false);
        expect.soft(payload.replyToId).toBeUndefined();
        expect.soft(Boolean(payload.replyToCurrent || payload.replyToTag)).toBe(false);
      }
    } finally {
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      subscription.unsubscribe();
      pipeline.stop();
      typing.cleanup();
    }
  });
});

describe("authoritative directive frames", () => {
  it.each([
    {
      name: "ordinary text",
      text: "Visible reply.",
      expectedText: "Visible reply.",
      audioAsVoice: false,
      silent: false,
    },
    {
      name: "bare voice intent",
      text: "[[audio_as_voice]]",
      expectedText: "",
      audioAsVoice: true,
      silent: false,
    },
    {
      name: "silent voice intent",
      text: "[[audio_as_voice]]NO_REPLY",
      expectedText: "",
      audioAsVoice: true,
      silent: true,
    },
  ])("carries terminal $name classification to the block payload", async (scenario) => {
    const blocks: ReplyPayload[] = [];
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run-terminal-silence",
      onBlockReply: (payload) => {
        blocks.push(payload);
      },
      blockReplyBreak: "message_end",
    });
    try {
      emit({ type: "message_start", message: createAssistantOutput(googleModel) });
      emit({
        type: "message_end",
        message: {
          ...createAssistantOutput(googleModel),
          content: [{ type: "text", text: scenario.text }],
        },
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
          text: scenario.expectedText,
          audioAsVoice: scenario.audioAsVoice,
          silentReply: scenario.silent ? true : undefined,
        },
      ]);
    } finally {
      subscription.unsubscribe();
    }
  });

  it("applies a directive-only text_end to already-buffered audio", async () => {
    const { delivered, pipeline, typing, handler, emit, subscription } = createDeliveryHarness();
    try {
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
    } finally {
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      subscription.unsubscribe();
      pipeline.stop();
      typing.cleanup();
    }
  });

  const first = "[[audio_as_voice]]First reply.\n\n" + nextParagraph;
  const corrected =
    first + "The corrected tail is long enough to flush after the committed prefix.\n\n";
  it.each([
    {
      name: "same-item replacement retains the terminal snapshot reset",
      expectedReplies: ["First reply."],
      updates: [
        { type: "text_delta", text: first, item: 0, edges: 1 },
        { type: "text_end", text: corrected, item: 0, edges: 2 },
      ],
    },
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
  ])("preserves $name", async ({ updates, expectedReplies }) => {
    const { delivered, blocks, pipeline, typing, handler, emit, subscription } =
      createDeliveryHarness();
    const message = (text: string, item: number) => ({
      role: "assistant",
      api: "openai-responses",
      content: [
        {
          type: "text",
          text,
          textSignature: JSON.stringify({ v: 1, id: `item-${item}`, phase: "final_answer" }),
        },
      ],
    });
    try {
      await handler({ mediaUrls: [audioUrl] });
      emit({ type: "message_start", message: message("", 0) });
      for (const update of updates) {
        const partial = message(update.text, update.item);
        emit({
          type: "message_update",
          message: partial,
          assistantMessageEvent: {
            type: update.type,
            contentIndex: update.item,
            partial,
            ...(update.type === "text_delta" ? { delta: update.text } : { content: update.text }),
          },
        });
        await subscription.waitForPendingEvents();
        await pipeline.flush({ force: true });
        expect.soft(blocks.filter((payload) => payload.audioAsVoice)).toHaveLength(update.edges);
      }
      for (const text of expectedReplies) {
        expect(delivered.filter((payload) => payload.text === text)).toHaveLength(1);
      }
      const audio = delivered.filter(isAudioPayload);
      expect(audio).toHaveLength(1);
      expect(audio[0]?.audioAsVoice).toBe(true);
    } finally {
      await subscription.waitForPendingEvents();
      await pipeline.flush({ force: true });
      subscription.unsubscribe();
      pipeline.stop();
      typing.cleanup();
    }
  });
});

describe("hasAssistantVisibleReply", () => {
  it("treats audio-only payloads as visible", () => {
    expect(hasAssistantVisibleReply({ audioAsVoice: true })).toBe(true);
  });

  it("detects text or media visibility", () => {
    expect(hasAssistantVisibleReply({ text: "hello" })).toBe(true);
    expect(hasAssistantVisibleReply({ mediaUrls: ["https://example.com/a.png"] })).toBe(true);
    expect(hasAssistantVisibleReply({})).toBe(false);
  });
});

describe("assistant stream managed media", () => {
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
});

describe("pending assistant reply directives", () => {
  it("merges directive metadata into the next non-reasoning block reply", () => {
    const state = { pendingAssistantReplyDirectives: undefined };

    recordPendingAssistantReplyDirectives(state, {
      text: "",
      replyToCurrent: true,
      replyToTag: true,
      audioAsVoice: true,
      isSilent: false,
    });

    expect(
      consumePendingAssistantReplyDirectivesIntoReply(state, {
        text: "Done.",
      }),
    ).toEqual({
      text: "Done.",
      audioAsVoice: true,
      replyToId: undefined,
      replyToTag: true,
      replyToCurrent: true,
    });
    expect(state.pendingAssistantReplyDirectives).toBeUndefined();
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
});

describe("resolveStreamingReply", () => {
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
});
