// Markdown block-reply chunking and fence preservation.
import { describe, expect, it, vi } from "vitest";
import { createBlockReplyPipeline } from "../auto-reply/reply/block-reply-pipeline.js";
import {
  createParagraphChunkedBlockReplyHarness,
  createSubscribedSessionHarness,
  createTextEndBlockReplyHarness,
  emitAssistantTextDelta,
  emitAssistantTextDeltaAndEnd,
  emitAssistantTextEnd,
  expectFencedChunks,
  extractTextPayloads,
} from "./embedded-agent-subscribe.e2e-harness.js";

describe("paragraph and whole-fence chunking", () => {
  const cases = [
    {
      name: "keeps indented fenced blocks intact",
      chunking: { minChars: 5, maxChars: 30 },
      text: "Intro\n\n  ```js\n  const x = 1;\n  ```\n\nOutro",
      expected: ["Intro", "  ```js\n  const x = 1;\n  ```", "Outro"],
    },
    {
      name: "accepts longer fence markers for close",
      chunking: { minChars: 10, maxChars: 30 },
      text: "Intro\n\n````md\nline1\nline2\n````\n\nOutro",
      expected: ["Intro", "````md\nline1\nline2\n````", "Outro"],
    },
    {
      name: "avoids splitting inside tilde fences",
      chunking: { minChars: 5, maxChars: 25 },
      text: "Intro\n\n~~~sh\nline1\nline2\n~~~\n\nOutro",
      expected: ["Intro", "~~~sh\nline1\nline2\n~~~", "Outro"],
    },
    {
      name: "streams soft chunks with paragraph preference",
      chunking: { minChars: 5, maxChars: 25 },
      text: "First block line\n\nSecond block line",
      expected: ["First block line", "Second block line"],
      expectAssistantTexts: true,
    },
    {
      name: "avoids splitting inside fenced code blocks",
      chunking: { minChars: 5, maxChars: 25 },
      text: "Intro\n\n```bash\nline1\nline2\n```\n\nOutro",
      expected: ["Intro", "```bash\nline1\nline2\n```", "Outro"],
    },
  ] as const;

  it.each(cases)("$name", ({ chunking, text, expected, ...testCase }) => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createParagraphChunkedBlockReplyHarness({
      onBlockReply,
      chunking,
    });
    emitAssistantTextDeltaAndEnd({ emit, text });

    expect(onBlockReply).toHaveBeenCalledTimes(expected.length);
    expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(expected);
    if ("expectAssistantTexts" in testCase) {
      expect(subscription.assistantTexts).toEqual(expected);
    }
  });
});

describe("oversized fenced block chunking", () => {
  it("preserves a held fence boundary across a tool flush", async () => {
    const prefix = "Intro\n\n~~~";
    const tail = "xml\n<final>literal</final>\n~~~\n\n<think>private</think>After";
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 1_200,
        breakPreference: "newline",
        flushOnParagraph: true,
      },
    });
    try {
      emitAssistantTextDelta({ emit, delta: prefix });
      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Intro"]);
      emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "tool-fence", args: {} });
      await subscription.waitForPendingEvents();
      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual(["Intro"]);
      emitAssistantTextDelta({ emit, delta: tail });
      emitAssistantTextEnd({ emit, content: prefix + tail });
      await subscription.waitForPendingEvents();
      expect(extractTextPayloads(onBlockReply.mock.calls)).toEqual([
        "Intro",
        "~~~xml\n<final>literal</final>\n~~~",
        "After",
      ]);
    } finally {
      emit({
        type: "tool_execution_end",
        toolName: "bash",
        toolCallId: "tool-fence",
        isError: false,
        result: {},
      });
      await subscription.waitForPendingEvents();
      subscription.unsubscribe();
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
    const onBlockReply = vi.fn();
    const { emit, subscription } = createSubscribedSessionHarness({
      runId: "run",
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
    try {
      emitAssistantTextDelta({ emit, delta: text });
      emitAssistantTextEnd({ emit, content: text });
      const chunks = extractTextPayloads(onBlockReply.mock.calls);
      expect(chunks.every((chunk) => chunk.length <= 1_200)).toBe(true);
      expect(
        chunks
          .flatMap((chunk) => chunk.split("\n").filter((line) => !line.startsWith("~~~")))
          .join(""),
      ).toBe(expected);
    } finally {
      subscription.unsubscribe();
    }
  });

  it.each([false, true])(
    "keeps inline tildes after a hard split outside code (later delta: %s)",
    (laterDelta) => {
      const prefix = "a".repeat(1_200);
      const continuation = laterDelta
        ? Array.from({ length: 600 }, (_, index) => index.toString(16).padStart(4, "0")).join("")
        : "";
      const tail = `~~~xml\n<think>private</think>${continuation}After`;
      const onBlockReply = vi.fn();
      const { emit, subscription } = createTextEndBlockReplyHarness({
        onBlockReply,
        blockReplyChunking: {
          minChars: 1,
          maxChars: 1_200,
          breakPreference: "newline",
          flushOnParagraph: true,
        },
      });
      try {
        if (laterDelta) {
          emitAssistantTextDelta({ emit, delta: prefix });
          emitAssistantTextDelta({ emit, delta: tail });
        } else {
          emitAssistantTextDelta({ emit, delta: prefix + tail });
        }
        emitAssistantTextEnd({ emit, content: prefix + tail });
        const chunks = extractTextPayloads(onBlockReply.mock.calls);
        expect(chunks.join("")).toBe(
          `${prefix}~~~xml${laterDelta ? "" : "\n"}${continuation}After`,
        );
        expect(chunks.every((chunk) => !chunk.includes("private") && chunk.length <= 1_200)).toBe(
          true,
        );
      } finally {
        subscription.unsubscribe();
      }
    },
  );

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
  ])("preserves fenced code and final prose when streaming $name", ({ text, expectedContent }) => {
    const onBlockReply = vi.fn();
    const { emit, subscription } = createTextEndBlockReplyHarness({
      onBlockReply,
      blockReplyChunking: {
        minChars: 1,
        maxChars: 1_200,
        breakPreference: "newline",
        flushOnParagraph: true,
      },
    });
    try {
      emitAssistantTextDelta({ emit, delta: text });
      expect(onBlockReply.mock.calls.length).toBeGreaterThan(1);
      emitAssistantTextEnd({ emit, content: text });
      const chunks = extractTextPayloads(onBlockReply.mock.calls);
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
    } finally {
      subscription.unsubscribe();
    }
  });

  it("acknowledges the original fenced answer after delivering its wrapped chunks", async () => {
    const delivered: string[] = [];
    const pipeline = createBlockReplyPipeline({
      onBlockReply: (payload) => {
        delivered.push(payload.text ?? "");
      },
      timeoutMs: 5000,
    });
    const { emit } = createParagraphChunkedBlockReplyHarness({
      chunking: { minChars: 8, maxChars: 20 },
      onBlockReply: (payload) => pipeline.enqueue(payload),
    });
    const text = "```ts\nabcdefghijklmnop\n```";
    emitAssistantTextDeltaAndEnd({ emit, text });
    await pipeline.flush({ force: true });

    expect(delivered).toEqual(["```ts\nabcdefghij\n```", "```ts\nklmnop\n```"]);
    expect(pipeline.hasSentPayload({ text })).toBe(true);
    expect(pipeline.hasSentPayload({ text: "```ts\nabcdefghijklmnopq\n```" })).toBe(false);
  });

  const cases = [
    {
      name: "reopens fenced blocks when splitting inside them",
      chunking: { minChars: 10, maxChars: 30 },
      text: `\`\`\`txt\n${"a".repeat(80)}\n\`\`\``,
      prefix: "```txt",
    },
    {
      name: "splits long single-line fenced blocks with reopen/close",
      chunking: { minChars: 10, maxChars: 40 },
      text: `\`\`\`json\n${"x".repeat(120)}\n\`\`\``,
      prefix: "```json",
    },
  ] as const;

  it.each(cases)("$name", async ({ chunking, text, prefix }) => {
    const onBlockReply = vi.fn();
    const { emit } = createParagraphChunkedBlockReplyHarness({ onBlockReply, chunking });
    emitAssistantTextDeltaAndEnd({ emit, text });
    await Promise.resolve();
    expectFencedChunks(onBlockReply.mock.calls, prefix);
  });
});
