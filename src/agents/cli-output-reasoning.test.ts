import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CliThinkingProgress } from "./cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "./cli-output-stream.js";

function joinJsonlFrames(...frames: unknown[]) {
  return frames
    .map((frame) => (typeof frame === "string" ? frame : JSON.stringify(frame)))
    .join("\n");
}

function claudeStreamEvent(event: Record<string, unknown>) {
  return { type: "stream_event", event };
}

function claudeMessageStart(id?: string) {
  return claudeStreamEvent({ type: "message_start", ...(id ? { message: { id } } : {}) });
}

function claudeBlockStart(contentBlock: Record<string, unknown>, index?: number) {
  return claudeStreamEvent({
    type: "content_block_start",
    ...(index === undefined ? {} : { index }),
    content_block: contentBlock,
  });
}

function claudeBlockStop(index?: number) {
  return claudeStreamEvent({
    type: "content_block_stop",
    ...(index === undefined ? {} : { index }),
  });
}

function claudeThinkingDelta(thinking: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "thinking_delta", thinking },
  });
}

function claudeInputJsonDelta(partialJson: string, index?: number) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "input_json_delta", partial_json: partialJson },
  });
}

function claudeAssistantSnapshot(id: string, content: unknown[]) {
  return { type: "assistant", message: { id, content } };
}

describe("createCliJsonlStreamingParser reasoning", () => {
  function createClaudeTaggedReasoningHarness() {
    const assistant: Array<{ text: string; delta: string }> = [];
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: (delta) => assistant.push(delta),
      onThinkingDelta: (delta) => thinking.push(delta),
    });
    return { assistant, parser, thinking };
  }

  it("promotes complete leading tagged Claude reasoning and keeps only the answer visible", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      [
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: {
              type: "text_delta",
              text: "<thinking>Private analysis.</thinking>Visible answer.",
            },
          },
        }),
        JSON.stringify({
          type: "result",
          session_id: "session-tagged",
          result: "<thinking>Private analysis.</thinking>Visible answer.",
        }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      {
        text: "Private analysis.",
        delta: "Private analysis.",
        isReasoningSnapshot: true,
      },
    ]);
    expect(assistant).toEqual([
      {
        text: "Visible answer.",
        delta: "Visible answer.",
        sessionId: undefined,
        usage: undefined,
      },
    ]);
    expect(parser.getOutput()).toEqual({
      text: "Visible answer.",
      sessionId: "session-tagged",
      usage: undefined,
    });
  });

  it("holds chunk-split tagged reasoning until its close tag is complete", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();
    const pushText = (text: string) =>
      parser.push(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        })}\n`,
      );

    pushText("<thi");
    pushText("nking>Private ");
    expect(assistant).toEqual([]);
    expect(thinking).toEqual([]);
    pushText("analysis.</think");
    expect(assistant).toEqual([]);
    expect(thinking).toEqual([]);
    pushText("ing>Visible answer.");
    parser.finish();

    expect(thinking.at(-1)?.text).toBe("Private analysis.");
    expect(assistant.at(-1)?.text).toBe("Visible answer.");
    expect(parser.getOutput()?.text).toBe("Visible answer.");
  });

  it("streams rejected angle prefixes while valid split reasoning stays buffered", () => {
    const visible = createClaudeTaggedReasoningHarness();
    const mixed = createClaudeTaggedReasoningHarness();
    const tagged = createClaudeTaggedReasoningHarness();
    const pushText = (parser: ReturnType<typeof createCliJsonlStreamingParser>, text: string) =>
      parser.push(
        `${JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        })}\n`,
      );

    pushText(visible.parser, "<div>Visible prefix <thi");
    expect(visible.assistant.at(-1)?.text).toBe("<div>Visible prefix <thi");
    expect(visible.parser.getOutput()?.text).toBe("<div>Visible prefix <thi");

    pushText(mixed.parser, "<div>Visible prefix ");
    pushText(mixed.parser, "<thi");
    expect(mixed.assistant.at(-1)?.text).toBe("<div>Visible prefix <thi");
    expect(mixed.parser.getOutput()?.text).toBe("<div>Visible prefix <thi");

    pushText(tagged.parser, "<thi");
    pushText(tagged.parser, "nking>Private analysis.");
    expect(tagged.assistant).toEqual([]);
    expect(tagged.thinking).toEqual([]);
    pushText(tagged.parser, "</thinking>Visible answer.");
    expect(tagged.thinking.at(-1)?.text).toBe("Private analysis.");
    expect(tagged.assistant.at(-1)?.text).toBe("Visible answer.");
  });

  it("promotes consecutive leading blocks but preserves later literal tags", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: {
            type: "text_delta",
            text: [
              "<think>First.</think>",
              "<reasoning>Second.</reasoning>",
              "Answer with <think>literal</think> markup.",
            ].join("\n"),
          },
        },
      })}\n`,
    );
    parser.finish();

    expect(thinking.map((entry) => entry.text)).toEqual(["First.Second."]);
    expect(assistant.at(-1)?.text).toBe("\nAnswer with <think>literal</think> markup.");
    expect(parser.getOutput()?.text).toBe("Answer with <think>literal</think> markup.");
  });

  it("prefers native Claude thinking over a mirrored leading tagged block", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      [
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "Native analysis." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            index: 1,
            delta: {
              type: "text_delta",
              text: "<thinking>Native analysis.</thinking>Visible answer.",
            },
          },
        }),
        JSON.stringify({
          type: "result",
          result: "<thinking>Native analysis.</thinking>Visible answer.",
        }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking).toEqual([
      { text: "Native analysis.", delta: "Native analysis.", isReasoningSnapshot: true },
    ]);
    expect(assistant.at(-1)?.text).toBe("Visible answer.");
    expect(parser.getOutput()?.text).toBe("Visible answer.");
  });

  it.each([
    {
      name: "fenced code example",
      text: "```xml\n<thinking>literal example</thinking>\n```",
    },
    { name: "incomplete leading tag", text: "<thinking>unfinished visible text" },
    { name: "malformed leading tag", text: "<thinking broken visible text" },
  ])("preserves $name on the visible path", ({ text }) => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();

    parser.push(
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      })}\n`,
    );
    parser.finish();

    expect(thinking).toEqual([]);
    expect(assistant.map((entry) => entry.delta).join("")).toBe(text);
    expect(parser.getOutput()?.text).toBe(text);
  });

  it("resets tagged reasoning across Claude tool-round assistant messages", () => {
    const { assistant, parser, thinking } = createClaudeTaggedReasoningHarness();
    const textEvent = (text: string) =>
      JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text },
        },
      });

    parser.push(
      [
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        textEvent("<think>First thought.</think>Before tool."),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", id: "tool-1", name: "Read" },
          },
        }),
        JSON.stringify({ type: "stream_event", event: { type: "message_stop" } }),
        JSON.stringify({ type: "stream_event", event: { type: "message_start" } }),
        textEvent("<reasoning>Second thought.</reasoning>Final answer."),
        JSON.stringify({ type: "result", result: "Final answer." }),
        "",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking.map((entry) => entry.text)).toEqual(["First thought.", "Second thought."]);
    expect(assistant.at(-1)?.text).toBe("Before tool.\n\nFinal answer.");
    expect(parser.getOutput()?.text).toBe("Before tool.\n\nFinal answer.");
  });

  it.each([
    {
      name: "streams thinking deltas, skips signature deltas, and dedupes the snapshot",
      frames: [
        claudeThinkingDelta("Let me think", 0),
        claudeThinkingDelta(" harder.", 0),
        claudeStreamEvent({
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "opaque-signature" },
        }),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "Let me think harder.", signature: "opaque-signature" },
          { type: "text", text: "Answer." },
        ]),
      ],
      expected: [
        { text: "Let me think", delta: "Let me think", isReasoningSnapshot: true },
        { text: "Let me think harder.", delta: " harder.", isReasoningSnapshot: true },
      ],
    },
    {
      name: "keeps snapshot-only thinking blocks ordered when later deltas arrive",
      frames: [
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "Snapshot-only reasoning.", signature: "sig" },
          { type: "redacted_thinking", data: "opaque-blob" },
          { type: "thinking", thinking: " Next block." },
          { type: "text", text: "Answer." },
        ]),
        claudeThinkingDelta(" Revised.", 0),
        claudeThinkingDelta(" Done.", 2),
      ],
      expected: [
        {
          text: "Snapshot-only reasoning.",
          delta: "Snapshot-only reasoning.",
          isReasoningSnapshot: true,
        },
        {
          text: "Snapshot-only reasoning. Next block.",
          delta: " Next block.",
          isReasoningSnapshot: true,
        },
        {
          text: "Snapshot-only reasoning. Revised. Next block.",
          delta: " Revised.",
          isReasoningSnapshot: true,
        },
        {
          text: "Snapshot-only reasoning. Revised. Next block. Done.",
          delta: " Done.",
          isReasoningSnapshot: true,
        },
      ],
    },
    {
      name: "replaces per-index thinking when assistant snapshots revise non-prefix text",
      frames: [
        claudeThinkingDelta("rough draft", 0),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "revised thought", signature: "sig" },
          { type: "text", text: "Answer." },
        ]),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "revised thought", signature: "sig" },
          { type: "text", text: "Answer." },
        ]),
        claudeThinkingDelta(" continued", 0),
      ],
      expected: [
        { text: "rough draft", delta: "rough draft", isReasoningSnapshot: true },
        { text: "revised thought", delta: "revised thought", isReasoningSnapshot: true },
        { text: "revised thought continued", delta: " continued", isReasoningSnapshot: true },
      ],
    },
    {
      name: "dedupes per content-block index across multiple thinking blocks",
      frames: [
        claudeThinkingDelta("A", 0),
        claudeThinkingDelta("B", 1),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "A", signature: "sig-a" },
          { type: "thinking", thinking: "B", signature: "sig-b" },
        ]),
        claudeThinkingDelta("C", 0),
        claudeThinkingDelta("D", 1),
      ],
      expected: [
        { text: "A", delta: "A", isReasoningSnapshot: true },
        { text: "AB", delta: "B", isReasoningSnapshot: true },
        { text: "ACB", delta: "C", isReasoningSnapshot: true },
        { text: "ACBD", delta: "D", isReasoningSnapshot: true },
      ],
    },
    {
      name: "orders new earlier thinking blocks before appending to the greatest index",
      frames: [
        claudeThinkingDelta("C", 2),
        claudeThinkingDelta("A", 0),
        claudeThinkingDelta("B", 1),
        claudeThinkingDelta("D", 2),
        claudeThinkingDelta("E", 0),
      ],
      expected: [
        { text: "C", delta: "C", isReasoningSnapshot: true },
        { text: "AC", delta: "A", isReasoningSnapshot: true },
        { text: "ABC", delta: "B", isReasoningSnapshot: true },
        { text: "ABCD", delta: "D", isReasoningSnapshot: true },
        { text: "AEBCD", delta: "E", isReasoningSnapshot: true },
      ],
    },
    {
      name: "preserves negative, infinite, and signed-zero thinking indexes",
      // Raw JSON preserves overflowed numeric exponents and negative zero.
      frames: [
        { index: "-1e400", thinking: "L" },
        { index: "-1e400", thinking: "!" },
        { index: "-2", thinking: "N" },
        { index: "-0", thinking: "Z" },
        { index: "0", thinking: "+" },
        { index: "1e400", thinking: "H" },
        { index: "1e400", thinking: "!" },
        { index: "-2", thinking: "?" },
      ].map(
        ({ index, thinking }) =>
          `{"type":"stream_event","event":{"type":"content_block_delta","index":${index},"delta":{"type":"thinking_delta","thinking":${JSON.stringify(thinking)}}}}`,
      ),
      expected: [
        { text: "L", delta: "L", isReasoningSnapshot: true },
        { text: "L!", delta: "!", isReasoningSnapshot: true },
        { text: "L!N", delta: "N", isReasoningSnapshot: true },
        { text: "L!NZ", delta: "Z", isReasoningSnapshot: true },
        { text: "L!NZ+", delta: "+", isReasoningSnapshot: true },
        { text: "L!NZ+H", delta: "H", isReasoningSnapshot: true },
        { text: "L!NZ+H!", delta: "!", isReasoningSnapshot: true },
        { text: "L!N?Z+H!", delta: "?", isReasoningSnapshot: true },
      ],
    },
    {
      name: "dedupes snapshot thinking after tool-interleaved multi-block streaming",
      frames: [
        claudeThinkingDelta("A", 0),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "Read" }, 1),
        claudeInputJsonDelta('{"file_path":"x"}', 1),
        claudeBlockStop(1),
        claudeThinkingDelta("B", 2),
        claudeAssistantSnapshot("msg-1", [
          { type: "thinking", thinking: "A", signature: "sig-a" },
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } },
          { type: "thinking", thinking: "B", signature: "sig-b" },
        ]),
      ],
      expected: [
        { text: "A", delta: "A", isReasoningSnapshot: true },
        { text: "AB", delta: "B", isReasoningSnapshot: true },
      ],
    },
    {
      name: "streams indexless thinking deltas from content block framing",
      frames: [
        claudeMessageStart("msg-1"),
        claudeBlockStart({ type: "thinking" }),
        claudeThinkingDelta("A"),
        claudeBlockStop(),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "Read" }),
        claudeInputJsonDelta('{"file_path":"x"}'),
        claudeBlockStop(),
        claudeBlockStart({ type: "thinking" }),
        claudeThinkingDelta("B"),
        claudeBlockStop(),
        claudeAssistantSnapshot("msg-1", [{ type: "text", text: "Answer." }]),
      ],
      expected: [
        { text: "A", delta: "A", isReasoningSnapshot: true },
        { text: "AB", delta: "B", isReasoningSnapshot: true },
      ],
    },
  ])("$name", ({ frames, expected }) => {
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "local-cli",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "local-cli",
      onAssistantDelta: () => {},
      onThinkingDelta: (delta) => thinking.push(delta),
    });

    parser.push(joinJsonlFrames(...frames));
    parser.finish();

    expect(thinking).toEqual(expected);
  });

  it("emits token progress for Claude CLI 2.1 empty thinking deltas", () => {
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const progress: CliThinkingProgress[] = [];
    const parser = createCliJsonlStreamingParser({
      backend: {
        command: "claude",
        output: "jsonl",
        jsonlDialect: "claude-stream-json",
        sessionIdFields: ["session_id"],
      },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onThinkingDelta: (delta) => thinking.push(delta),
      onThinkingProgress: (payload) => progress.push(payload),
    });

    parser.push(readFileSync("test/fixtures/cli/claude-2.1-thinking-progress.jsonl", "utf8"));
    parser.finish();

    expect(thinking).toEqual([]);
    expect(progress).toEqual([
      { progressTokens: 50 },
      { progressTokens: 200 },
      { progressTokens: 300 },
    ]);
  });
});
