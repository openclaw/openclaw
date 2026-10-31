import { describe, expect, it, onTestFinished, vi } from "vitest";
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

type Reply = Parameters<NonNullable<SubscribeEmbeddedAgentSessionParams["onBlockReply"]>>[0];
function blockHarness(
  maxChars: number,
  options: { enforceFinalTag?: boolean; flushOnParagraph?: boolean } = {},
) {
  const onBlockReply = vi.fn<(payload: Reply) => void>();
  const harness = createSubscribedSessionHarness({
    runId: "fences",
    onBlockReply,
    enforceFinalTag: options.enforceFinalTag,
    blockReplyBreak: "text_end",
    blockReplyChunking: {
      minChars: 1,
      maxChars,
      breakPreference: "newline",
      flushOnParagraph: options.flushOnParagraph,
    },
  });
  onTestFinished(async () => {
    harness.subscription.unsubscribe();
    await harness.subscription.waitForPendingEvents();
  });
  return {
    ...harness,
    chunks: () => extractTextPayloads(onBlockReply.mock.calls),
    payloads: () => onBlockReply.mock.calls.map(([payload]) => payload),
    delta: (delta: string) => emitAssistantTextDelta({ emit: harness.emit, delta }),
    end: (content: string) => emitAssistantTextEnd({ emit: harness.emit, content }),
  };
}
const fenceHarness = (enforceFinalTag = false) =>
  blockHarness(1_200, { enforceFinalTag, flushOnParagraph: true });
const unfenced = (chunks: string[], marker: string) =>
  chunks.flatMap((chunk) => chunk.split("\n").filter((line) => !line.startsWith(marker))).join("");

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
      expect(chunks()).toEqual(["Intro", "  ~~~xml\n  <final>literal</final>\n  ~~~", "\n\nAfter"]);
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
    expect(unfenced(chunks, "~~~")).toBe(expected);
  });

  it("preserves fenced code and final prose in a long fence", () => {
    const text = `\`\`\`txt\n${"code\n\n".repeat(600)}\`\`\`\n\nAfter`;
    const harness = fenceHarness();
    harness.delta(text);
    expect(harness.chunks().length).toBeGreaterThan(1);
    harness.end(text);
    const chunks = harness.chunks();
    expect(chunks.at(-1)).toBe("\n\nAfter");
    expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
    for (const chunk of chunks.slice(0, -1)) {
      expect(chunk.startsWith("```txt\n")).toBe(true);
      expect(chunk.trimEnd().endsWith("```")).toBe(true);
    }
    expect(unfenced(chunks, "```").replace(/\s/g, "")).toBe(`${"code".repeat(600)}After`);
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
      occurrences.some((occurrence) =>
        occurrences.some(
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

async function expectPrivateDeltas(deltas: string[], finish = true, rejectTags = true) {
  const onPartialReply = vi.fn();
  const onBlockReply = vi.fn();
  const { emit, subscription } = createSubscribedSessionHarness({
    runId: "reasoning-tags",
    reasoningMode: "off",
    onPartialReply,
    ...(finish ? { onBlockReply, blockReplyBreak: "text_end" } : {}),
  });
  onTestFinished(() => subscription.unsubscribe());
  for (const delta of deltas) {
    emitAssistantTextDelta({ emit, delta });
    await subscription.waitForPendingEvents();
    const partials = extractTextPayloads(onPartialReply.mock.calls);
    for (const text of rejectTags ? partials : [partials.join("")]) {
      expect(text).not.toContain("PRIVATE_MARKER");
      if (rejectTags) {
        expect(text).not.toContain("<");
      }
    }
  }
  if (finish) {
    const content = deltas.join("");
    emitAssistantTextEnd({ emit, content });
    emit({ type: "message_end", message: textAssistant(content) });
    await subscription.waitForPendingEvents();
    expect(extractTextPayloads(onBlockReply.mock.calls).join("")).toBe("Before  After");
  }
  expect(extractTextPayloads(onPartialReply.mock.calls).at(-1)).toBe("Before  After");
}

describe("streamed reasoning tag privacy", () => {
  it.each(["reasoning", "internal", "antml:reasoning", "mm:reasoning"])(
    "withholds split <%s> blocks before partial or block delivery",
    async (tag) => {
      await expectPrivateDeltas([
        "Before ",
        "<",
        tag.slice(0, 2),
        `${tag.slice(2)}>`,
        "PRIVATE_MARKER",
        `</${tag}>`,
        " After",
      ]);
    },
  );

  it.each([
    ["think", "internal"],
    ["internal", "reasoning"],
  ])("withholds nested <%s> and <%s> blocks through the outer close", async (outer, inner) => {
    await expectPrivateDeltas(
      [`Before <${outer}>outer<${inner}>inner</${inner}>`, "PRIVATE_MARKER", `</${outer}> After`],
      true,
      false,
    );
  });

  it("holds a reasoning tag whose quoted attribute contains a split closing bracket", async () => {
    await expectPrivateDeltas(
      ["Before <reasoning note='a>", "b'>PRIVATE_MARKER", "</reasoning> After"],
      false,
    );
  });

  const literal = "Use `<reasoning note='literal>` and `<internal>literal</internal>`.";
  it.each([
    ["internal", "stream", "Before <internal>PRIVATE_MARKER</internal> After", "Before  After"],
    ["code", "off", `${literal} <reasoning>PRIVATE_MARKER</reasoning> After`, `${literal}  After`],
    ["self-closing", "off", "Before <reasoning/> After", "Before  After"],
  ] as const)("keeps reasoning private: %s", (_name, reasoningMode, delta, expected) => {
    const onPartialReply = vi.fn();
    const onReasoningStream = reasoningMode === "stream" ? vi.fn() : undefined;
    const emit = subscribe({ reasoningMode, onPartialReply, onReasoningStream });
    emitAssistantTextDelta({ emit, delta });
    expect(extractTextPayloads(onPartialReply.mock.calls)).toEqual([expected]);
    if (onReasoningStream) {
      expect(onReasoningStream).not.toHaveBeenCalled();
    }
  });
});

describe("streamed final tags", () => {
  it("closes hidden reasoning fences split across deltas", () => {
    const reply = vi.fn();
    const emit = subscribe({ enforceFinalTag: true, onPartialReply: reply });
    emit({ type: "message_start", message: { role: "assistant" } });
    for (const delta of [
      "<think>\n```ts\nconst hidden = true;\n``",
      "`\n</think><final>Answer</final>",
    ]) {
      emitAssistantTextDelta({ emit, delta });
    }
    expect(reply.mock.calls.map(([payload]) => payload.text)).toEqual(["Answer"]);
  });

  it.each([
    [
      "self-closing final closer",
      "<final data-model='gemma'>Visible<final data-model='x' />hidden",
    ],
    ["leading self-closing final opener", "<final data-model=openrouter/google/gemini/>Visible"],
  ])("preserves enforced content with a %s", (_name, delta) => {
    const onPartialReply = vi.fn();
    const emit = subscribe({ enforceFinalTag: true, onPartialReply });
    emit({ type: "message_start", message: { role: "assistant" } });
    emitAssistantTextDelta({ emit, delta });
    expect(
      onPartialReply.mock.calls
        .map(([p]) => p.delta)
        .filter((value) => typeof value === "string")
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

function replies() {
  const harness = blockHarness(50);
  const message = { role: "assistant", phase: "final_answer", content: [] };
  harness.emit({ type: "message_start", message });
  return {
    ...harness,
    end: (text: string) => harness.emit({ type: "message_end", message: textAssistant(text) }),
    message,
  };
}

describe("subscribeEmbeddedAgentSession reply tags", () => {
  it("delivers voice intent before text_end without leaking metadata", async () => {
    const h = replies();
    for (const delta of [
      "[[audio_as_voice]]Hello.\n\n",
      "An ordinary paragraph is long enough to drain the earlier voice block.\n\n",
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
    expect(payloads[0]?.text).toBe("Hello.");
    expect(Boolean(payloads[0]?.audioAsVoice)).toBe(true);
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
    [
      "valid media",
      "Hello\nMEDIA:https://example.com/a.png",
      ["Hello", ""],
      ["https://example.com/a.png"],
      false,
    ],
    [
      "unclosed fence",
      "```text\nMEDIA:https://example.com/a.png",
      ["```text\nMEDIA:https://example.com/a.png\n```"],
      [],
      true,
    ],
  ] as const)("flushes trailing directive tails: %s", (_name, text, texts, media, early) => {
    const h = replies();
    h.delta(text);
    emitAssistantTextEnd(h);
    if (early) {
      expect(h.payloads().map((payload) => payload.text)).toEqual(texts);
    }
    h.end(text);
    expect(h.payloads().map((payload) => payload.text)).toEqual(texts);
    expect(h.payloads().flatMap((payload) => payload.mediaUrls ?? [])).toEqual(media);
  });
});
