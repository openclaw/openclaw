import { describe, expect, it, onTestFinished, vi, afterEach } from "vitest";
import {
  readReplyPayloadSourceOccurrence,
  type ReplyPayloadSourceOccurrence,
} from "../auto-reply/reply-payload.js";
import { createBlockReplyPipeline } from "../auto-reply/reply/block-reply-pipeline.js";
import {
  createParagraphChunkedBlockReplyHarness,
  createSubscribedSessionHarness,
  emitAssistantTextDelta,
  emitAssistantTextDeltaAndEnd,
  emitAssistantTextEnd,
  expectFencedChunks,
  extractTextPayloads,
  createTextEndBlockReplyHarness,
  emitMessageStartAndEndForAssistantText,
  extractAgentEventPayloads,
  expectSingleAgentEventText,
} from "./embedded-agent-subscribe.e2e-harness.js";
import type { SubscribeEmbeddedAgentSessionParams } from "./embedded-agent-subscribe.types.js";
import { textAssistant } from "./test-helpers/sparse-transcript.test-support.js";

function fenceHarness(enforceFinalTag = false) {
  const onBlockReply = vi.fn();
  const harness = createSubscribedSessionHarness({
    runId: "fences",
    onBlockReply,
    enforceFinalTag,
    blockReplyBreak: "text_end",
    blockReplyChunking: {
      minChars: 1,
      maxChars: 1_200,
      breakPreference: "newline",
      flushOnParagraph: true,
    },
  });
  onTestFinished(() => harness.subscription.unsubscribe());
  return {
    ...harness,
    chunks: () => extractTextPayloads(onBlockReply.mock.calls),
    delta: (delta: string) => emitAssistantTextDelta({ emit: harness.emit, delta }),
    end: (content: string) => emitAssistantTextEnd({ emit: harness.emit, content }),
  };
}

describe("fenced block streaming", () => {
  it("preserves an indented held fence boundary across a tool flush", async () => {
    const prefix = "Intro\n\n  ~~~";
    const tail = "xml\n  <final>literal</final>\n  ~~~\n\n<think>private</think>After";
    const { emit, subscription, delta, end, chunks } = fenceHarness();
    try {
      delta(prefix);
      expect(chunks()).toEqual(["Intro"]);
      emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "fence", args: {} });
      await subscription.waitForPendingEvents();
      expect(chunks()).toEqual(["Intro"]);
      delta(tail);
      end(prefix + tail);
      await subscription.waitForPendingEvents();
      expect(chunks()).toEqual(["Intro", "  ~~~xml\n  <final>literal</final>\n  ~~~", "After"]);
    } finally {
      emit({
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "fence",
        isError: false,
        result: {},
      });
      await subscription.waitForPendingEvents();
    }
  });

  it.each([
    {
      name: "hidden reasoning",
      enforceFinalTag: false,
      text: `<think>\n~~~txt\n${"secret\n".repeat(300)}literal</think>private\n~~~\n</think>After`,
      expected: "After",
    },
    {
      name: "enforced final output",
      enforceFinalTag: true,
      text: `<final>\n~~~txt\n${"code\n".repeat(300)}<final>literal</final>\n~~~\n\nAfter</final>`,
      expected: `${"code".repeat(300)}<final>literal</final>After`,
    },
  ])("preserves wrapped fence semantics in $name", ({ enforceFinalTag, text, expected }) => {
    const harness = fenceHarness(enforceFinalTag);
    harness.delta(text);
    harness.end(text);
    const chunks = harness.chunks();
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
    expect(
      chunks
        .flatMap((chunk) => chunk.split("\n").filter((line) => !line.startsWith("~~~")))
        .join(""),
    ).toBe(expected);
  });

  it.each([
    {
      name: "a long fence",
      text: `\`\`\`txt\n${"code\n\n".repeat(600)}\`\`\`\n\nAfter`,
      expectedContent: `${"code".repeat(600)}After`,
    },
  ])("preserves fenced code and final prose in $name", ({ text, expectedContent }) => {
    const harness = fenceHarness();
    harness.delta(text);
    expect(harness.chunks().length).toBeGreaterThan(1);
    harness.end(text);
    const chunks = harness.chunks();
    expect(chunks.at(-1)).toBe("After");
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.startsWith("```txt\n")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
    }
    const rendered = chunks
      .flatMap((chunk) => chunk.split("\n").filter((line) => !line.startsWith("```")))
      .join("")
      .replace(/\s/g, "");
    expect(rendered).toBe(expectedContent);
  });

  it("delivers identical fenced chunks as distinct source occurrences with coalescing", async () => {
    const delivered: string[] = [];
    const occurrences: ReplyPayloadSourceOccurrence[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: (payload) => {
        delivered.push(payload.text ?? "");
      },
      timeoutMs: 5000,
      coalescing: { minChars: 1, maxChars: 30, idleMs: 0, joiner: "\n\n" },
    });
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      chunking: { minChars: 10, maxChars: 30 },
      onBlockReply: (payload) => {
        const occurrence = readReplyPayloadSourceOccurrence(payload);
        if (occurrence) {
          occurrences.push(occurrence);
        }
        pipeline.enqueue(payload);
      },
    });
    onTestFinished(() => subscription.unsubscribe());
    const text = `\`\`\`txt\n${"a".repeat(80)}\n\`\`\``;
    emitAssistantTextDeltaAndEnd({ emit, text });
    await pipeline.flush({ force: true });
    expect(delivered.length).toBeGreaterThan(2);
    expectFencedChunks(
      delivered.map((chunk) => [{ text: chunk }]),
      "```txt",
    );
    expect(pipeline.hasSentPayload({ text })).toBe(true);
    expect(
      occurrences.some((occurrence, index) =>
        occurrences
          .slice(index + 1)
          .some(
            (candidate) =>
              candidate.sourceText === occurrence.sourceText &&
              candidate.sourceRange[0] !== occurrence.sourceRange[0],
          ),
      ),
    ).toBe(true);
  });
});

function subscribe(options: Omit<Parameters<typeof createSubscribedSessionHarness>[0], "runId">) {
  const { emit, subscription } = createSubscribedSessionHarness({ runId: "run", ...options });
  onTestFinished(() => subscription.unsubscribe());
  return emit;
}

describe("streamed final tags", () => {
  it.each([
    {
      name: "closes hidden reasoning fences split across deltas",
      deltas: ["<think>\n```ts\nconst hidden = true;\n``", "`\n</think><final>Answer</final>"],
      expected: "Answer",
      partial: true,
    },
  ])("$name", ({ deltas, expected, partial }) => {
    const reply = vi.fn();
    const emit = subscribe({
      enforceFinalTag: true,
      ...(partial ? { onPartialReply: reply } : { onAgentEvent: reply }),
    });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of deltas) {
      emitAssistantTextDelta({ emit, delta });
    }
    const payloads = partial
      ? reply.mock.calls.map(([p]) => p)
      : extractAgentEventPayloads(reply.mock.calls);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.text).toBe(expected);
  });

  it.each([
    {
      name: "self-closing final closer",
      deltas: ["<final data-model='gemma'>Visible<final data-model='x' />hidden"],
    },
    {
      name: "leading self-closing final opener",
      deltas: ["<final data-model=openrouter/google/gemini/>Visible"],
    },
  ])("preserves enforced content with a $name", ({ deltas }) => {
    const onPartialReply = vi.fn();
    const emit = subscribe({ enforceFinalTag: true, onPartialReply });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of deltas) {
      emitAssistantTextDelta({ emit, delta });
    }
    expect(
      onPartialReply.mock.calls
        .map(([p]) => p.delta)
        .filter((delta) => typeof delta === "string")
        .join(""),
    ).toBe("Visible");
  });

  it("strips split final tags without remnants or replacement events", () => {
    const onAgentEvent = vi.fn();
    const emit = subscribe({ onAgentEvent });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of ["<", "final>Title\n", "Line one\nLine two</", "final>"]) {
      emitAssistantTextDelta({ emit, delta });
    }
    const payloads = extractAgentEventPayloads(onAgentEvent.mock.calls);
    const text = payloads.map((payload) => payload.delta).join("");
    expect(text).toBe("Title\nLine one\nLine two");
    expect(text).not.toContain("<");
    expect(text).not.toContain("final>");
    expect(payloads.some((payload) => payload.replace)).toBe(false);
  });

  it("keeps trailing tag prefixes when message_end drains chunked text_end replies", async () => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: { minChars: 1, maxChars: 200 },
    });
    onTestFinished(() => subscription.unsubscribe());
    const text = "Answer ends with <fi";
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta: text });
    emitAssistantTextEnd({ emit });
    emit({ type: "message_end", message: textAssistant(text) });
    await Promise.resolve();
    expect(onBlockReply.mock.calls.map(([payload]) => payload?.text)).toEqual([text]);
  });

  it("preserves literal trailing tag-prefix text in message_end fallback", () => {
    const onAgentEvent = vi.fn();
    const emit = subscribe({ onAgentEvent });
    emitMessageStartAndEndForAssistantText({ emit, text: "Answer ends with <" });
    expectSingleAgentEventText(onAgentEvent.mock.calls, "Answer ends with <");
  });
});

type Reply = Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0];
const subscriptions: Array<ReturnType<typeof createSubscribedSessionHarness>["subscription"]> = [];
afterEach(async () => {
  for (const subscription of subscriptions.splice(0)) {
    subscription.unsubscribe();
    await subscription.waitForPendingEvents();
  }
});
function replies(partial = false) {
  const onReply = vi.fn<(payload: Reply) => void>();
  const harness = createSubscribedSessionHarness({
    runId: "reply-tags",
    ...(partial ? { onPartialReply: onReply } : { onBlockReply: onReply }),
    blockReplyBreak: "text_end",
    blockReplyChunking: { minChars: 1, maxChars: 50, breakPreference: "newline" },
  });
  subscriptions.push(harness.subscription);
  const message = { role: "assistant", phase: "final_answer", content: [] };
  harness.emit({ type: "message_start", message });
  return {
    ...harness,
    onReply,
    payloads: () => onReply.mock.calls.map(([payload]) => payload),
    delta: (delta: string) => emitAssistantTextDelta({ emit: harness.emit, delta }),
    end: (text: string) =>
      harness.emit({
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      }),
    message,
  };
}

describe("subscribeEmbeddedAgentSession reply tags", () => {
  it.each([
    {
      name: "voice intent",
      chunks: [
        "[[audio_as_voice]]Hello.\n\n",
        "An ordinary paragraph is long enough to drain the earlier voice block.\n\n",
      ],
      voice: true,
    },
  ])("delivers $name before text_end without leaking metadata", async ({ chunks, voice }) => {
    const h = replies();
    for (const delta of [
      ...chunks,
      "A second paragraph gives the first completed block enough text to drain.",
    ]) {
      h.emit({
        type: "message_update",
        message: h.message,
        assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta },
      });
    }
    await h.subscription.waitForPendingEvents();
    const payloads = h.payloads();
    if (voice) {
      expect(payloads[0]?.text).toBe("Hello.");
    } else {
      expect(payloads.map((payload) => payload.text).join("")).toContain("[[reply_to:example-id]]");
    }
    expect(Boolean(payloads[0]?.audioAsVoice)).toBe(voice);
    for (const [index, payload] of payloads.entries()) {
      expect(payload.replyToId).toBeUndefined();
      expect(payload.replyToTag).toBeFalsy();
      expect(payload.replyToCurrent).toBeFalsy();
      if (index > 0) {
        expect(payload.audioAsVoice).toBeFalsy();
      }
    }
  });

  it("carries reply_to_current across tag-only block chunks", () => {
    const h = replies();
    h.delta("[[reply_to_current]]\nHello");
    emitAssistantTextEnd(h);
    h.end("[[reply_to_current]]\nHello");
    expect(h.payloads()).toEqual([
      expect.objectContaining({ text: "Hello", replyToCurrent: true, replyToTag: true }),
    ]);
  });

  it.each([
    {
      name: "valid media",
      text: "Hello\nMEDIA:https://example.com/a.png",
      final: "Hello\nMEDIA:https://example.com/a.png",
      texts: ["Hello", ""],
      media: ["https://example.com/a.png"],
      early: false,
    },

    {
      name: "unclosed fence",
      text: "```text\nMEDIA:https://example.com/a.png",
      final: "```text\nMEDIA:https://example.com/a.png",
      texts: ["```text\nMEDIA:https://example.com/a.png"],
      media: [],
      early: true,
    },
  ])("flushes trailing directive tails: $name", ({ text, final, texts, media, early }) => {
    const h = replies();
    h.delta(text);
    emitAssistantTextEnd(h);
    if (early) {
      expect(h.payloads().map((payload) => payload.text)).toEqual(texts);
    }
    h.end(final);
    expect(h.payloads().map((payload) => payload.text)).toEqual(texts);
    expect(h.payloads().flatMap((payload) => payload.mediaUrls ?? [])).toEqual(media);
  });
});
