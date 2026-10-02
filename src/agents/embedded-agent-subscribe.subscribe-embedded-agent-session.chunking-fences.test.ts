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
} from "./embedded-agent-subscribe.e2e-harness.js";

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

  it("keeps inline tildes after a hard split outside code across deltas", () => {
    const prefix = "a".repeat(1_200);
    const continuation = Array.from({ length: 600 }, (_, index) =>
      index.toString(16).padStart(4, "0"),
    ).join("");
    const tail = `~~~xml\n<think>private</think>${continuation}After`;
    const harness = fenceHarness();
    harness.delta(prefix);
    harness.delta(tail);
    harness.end(prefix + tail);
    const chunks = harness.chunks();
    expect(chunks.join("")).toBe(`${prefix}~~~xml${continuation}After`);
    expect(chunks.every((chunk) => !chunk.includes("private") && chunk.length <= 1_200)).toBe(true);
  });

  it.each([
    {
      name: "a long fence",
      text: `\`\`\`txt\n${"code\n\n".repeat(600)}\`\`\`\n\nAfter`,
      expectedContent: `${"code".repeat(600)}After`,
    },
    {
      name: "two fences before hidden reasoning",
      text: "```txt\n<final>literal</final>\n```\n\n```txt\nsecond\n```\n\n<think>private</think>After",
      expectedContent: "<final>literal</final>secondAfter",
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
