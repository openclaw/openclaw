import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type {
  CliJsonlStreamingParserOptions,
  CliThinkingProgress,
} from "./cli-output-contracts.js";
import {
  claudeBlockStart,
  claudeBlockStop,
  claudeInputJsonDelta,
  claudeStreamEvent,
  claudeTextDelta,
  createClaudeParser,
  joinJsonlFrames,
  finishCliFrames,
  localCliBackend as localBackend,
  claudeMessageStart,
} from "./cli-output.test-helpers.js";

function claudeThinkingDelta(thinking: string, index?: number | string) {
  return claudeStreamEvent({
    type: "content_block_delta",
    ...(index === undefined ? {} : { index }),
    delta: { type: "thinking_delta", thinking },
  });
}

function claudeAssistantSnapshot(id: string, content: unknown[]) {
  return { type: "assistant", message: { id, content } };
}

const reasoning = (text: string, delta = text) => ({
  text,
  delta,
  isReasoningSnapshot: true,
  modelProgress: true,
});
const thought = (thinking: string, signature?: string) => ({
  type: "thinking",
  thinking,
  signature,
});
const answer = { type: "text", text: "Answer." };

describe("createCliJsonlStreamingParser reasoning", () => {
  function createClaudeTaggedReasoningHarness(
    overrides: Partial<CliJsonlStreamingParserOptions> = {},
  ) {
    const assistant: Array<{ text: string; delta: string }> = [];
    const thinking: Array<{ text: string; delta: string; isReasoningSnapshot?: boolean }> = [];
    const parser = createClaudeParser({
      backend: localBackend,
      providerId: "local-cli",
      onAssistantDelta: (delta) => assistant.push(delta),
      onThinkingDelta: (delta) => thinking.push(delta),
      ...overrides,
    });
    const push = (...frames: unknown[]) => parser.push(joinJsonlFrames(...frames, ""));
    const pushText = (text: string) => push(claudeTextDelta(text));
    return { assistant, parser, thinking, push, pushText };
  }

  it("promotes complete leading tagged Claude reasoning and keeps only the answer visible", () => {
    const { assistant, parser, thinking, push } = createClaudeTaggedReasoningHarness();

    push(
      claudeMessageStart(),
      claudeTextDelta("<thinking>Private analysis.</thinking>Visible answer."),
      {
        type: "result",
        session_id: "session-tagged",
        result: "<thinking>Private analysis.</thinking>Visible answer.",
      },
    );
    parser.finish();

    expect(thinking).toEqual([reasoning("Private analysis.")]);
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

  it.each([
    { name: "tag name", chunks: ["<thi", "nking>Private "] },
    { name: "quoted attribute", chunks: ['<thinking note="', "x>y", '">Private '] },
  ])("holds reasoning with a split $name until its close tag is complete", ({ chunks }) => {
    const { assistant, parser, thinking, pushText } = createClaudeTaggedReasoningHarness();

    for (const chunk of chunks) {
      pushText(chunk);
      expect(assistant).toEqual([]);
      expect(thinking).toEqual([]);
    }
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
    const split = createClaudeTaggedReasoningHarness();
    const mixed = createClaudeTaggedReasoningHarness();
    visible.pushText("<div>Visible prefix <thi");
    expect(visible.assistant.at(-1)?.text).toBe("<div>Visible prefix <thi");
    expect(visible.parser.getOutput()?.text).toBe("<div>Visible prefix <thi");

    split.pushText("<thi");
    expect(split.assistant).toEqual([]);
    split.pushText("s");
    expect(split.assistant.at(-1)?.text).toBe("<this");
    split.pushText(">Visible");
    expect(split.assistant.at(-1)?.text).toBe("<this>Visible");

    mixed.pushText("<div>Visible prefix ");
    mixed.pushText("<thi");
    expect(mixed.assistant.at(-1)?.text).toBe("<div>Visible prefix <thi");
    expect(mixed.parser.getOutput()?.text).toBe("<div>Visible prefix <thi");
  });

  it("promotes consecutive leading blocks but preserves later literal tags", () => {
    const { assistant, parser, thinking, pushText } = createClaudeTaggedReasoningHarness();

    pushText(
      [
        "<think>First.</think>",
        "<reasoning>Second.</reasoning>",
        "Answer with <think>literal</think> markup.",
      ].join("\n"),
    );
    parser.finish();

    expect(thinking.map((entry) => entry.text)).toEqual(["First.Second."]);
    expect(assistant.at(-1)?.text).toBe("\nAnswer with <think>literal</think> markup.");
    expect(parser.getOutput()?.text).toBe("Answer with <think>literal</think> markup.");
  });

  it("prefers native Claude thinking over a mirrored leading tagged block", () => {
    const { assistant, parser, thinking, push } = createClaudeTaggedReasoningHarness();
    push(
      claudeThinkingDelta("Native analysis.", 0),
      claudeTextDelta("<thinking>Native analysis.</thinking>Visible answer.", 1),
      { type: "result", result: "<thinking>Native analysis.</thinking>Visible answer." },
    );
    parser.finish();

    expect(thinking).toEqual([reasoning("Native analysis.")]);
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

    finishCliFrames(parser, claudeTextDelta(text));

    expect(thinking).toEqual([]);
    expect(assistant.map((entry) => entry.delta).join("")).toBe(text);
    expect(parser.getOutput()?.text).toBe(text);
  });

  it("resets tagged reasoning across Claude tool-round assistant messages", () => {
    const { assistant, parser, thinking, push } = createClaudeTaggedReasoningHarness();
    push(
      claudeMessageStart(),
      claudeTextDelta("<think>First thought.</think>Before tool."),
      claudeBlockStart({ type: "tool_use", id: "tool-1", name: "Read" }),
      claudeStreamEvent({ type: "message_stop" }),
      claudeMessageStart(),
      claudeTextDelta("<reasoning>Second thought.</reasoning>Final answer."),
      { type: "result", result: "Final answer." },
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
          thought("Let me think harder.", "opaque-signature"),
          answer,
        ]),
      ],
      expected: [reasoning("Let me think"), reasoning("Let me think harder.", " harder.")],
    },
    {
      name: "keeps snapshot-only thinking blocks ordered when later deltas arrive",
      frames: [
        claudeAssistantSnapshot("msg-1", [
          thought("Snapshot-only reasoning.", "sig"),
          { type: "redacted_thinking", data: "opaque-blob" },
          thought(" Next block."),
          answer,
        ]),
        claudeThinkingDelta(" Revised.", 0),
        claudeThinkingDelta(" Done.", 2),
      ],
      expected: [
        reasoning("Snapshot-only reasoning."),
        reasoning("Snapshot-only reasoning. Next block.", " Next block."),
        reasoning("Snapshot-only reasoning. Revised. Next block.", " Revised."),
        reasoning("Snapshot-only reasoning. Revised. Next block. Done.", " Done."),
      ],
    },
    {
      name: "keeps fuller reasoning across prefix and full replays before a later delta",
      frames: [
        claudeMessageStart("msg-1"),
        claudeThinkingDelta("Known analysis", 0),
        claudeAssistantSnapshot("msg-1", [thought("Known")]),
        claudeAssistantSnapshot("msg-1", [thought("Known analysis")]),
        claudeThinkingDelta(" more", 0),
      ],
      expected: [
        {
          text: "Known analysis",
          delta: "Known analysis",
          isReasoningSnapshot: true,
          modelProgress: true,
        },
        {
          text: "Known analysis more",
          delta: " more",
          isReasoningSnapshot: true,
          modelProgress: true,
        },
      ],
    },
    {
      name: "replaces per-index thinking when assistant snapshots revise non-prefix text",
      frames: [
        claudeThinkingDelta("rough draft", 0),
        claudeAssistantSnapshot("msg-1", [thought("revised thought", "sig"), answer]),
        claudeAssistantSnapshot("msg-1", [thought("revised thought", "sig"), answer]),
        claudeThinkingDelta(" continued", 0),
      ],
      expected: [
        reasoning("rough draft"),
        reasoning("revised thought"),
        reasoning("revised thought continued", " continued"),
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
        reasoning("C"),
        reasoning("AC", "A"),
        reasoning("ABC", "B"),
        reasoning("ABCD", "D"),
        reasoning("AEBCD", "E"),
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
        reasoning("L"),
        reasoning("L!", "!"),
        reasoning("L!N", "N"),
        reasoning("L!NZ", "Z"),
        reasoning("L!NZ+", "+"),
        reasoning("L!NZ+H", "H"),
        reasoning("L!NZ+H!", "!"),
        reasoning("L!N?Z+H!", "?"),
      ],
    },
    {
      name: "dedupes and continues snapshot thinking after tool-interleaved streaming",
      frames: [
        claudeThinkingDelta("A", 0),
        claudeBlockStart({ type: "tool_use", id: "tool-1", name: "Read" }, 1),
        claudeInputJsonDelta('{"file_path":"x"}', 1),
        claudeBlockStop(1),
        claudeThinkingDelta("B", 2),
        claudeAssistantSnapshot("msg-1", [
          thought("A", "sig-a"),
          { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "x" } },
          thought("B", "sig-b"),
        ]),
        claudeThinkingDelta("C", 0),
        claudeThinkingDelta("D", 2),
      ],
      expected: [
        reasoning("A"),
        reasoning("AB", "B"),
        reasoning("ACB", "C"),
        reasoning("ACBD", "D"),
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
        claudeAssistantSnapshot("msg-1", [answer]),
      ],
      expected: [reasoning("A"), reasoning("AB", "B")],
    },
    {
      name: "resets per-index thinking state on a new message within the same turn (tool round-trip)",
      frames: [
        claudeMessageStart("msg-A"),
        claudeThinkingDelta("Hello ", 0),
        claudeThinkingDelta("world", 0),
        claudeAssistantSnapshot("msg-A", [thought("Hello world")]),
        claudeMessageStart("msg-B"),
        claudeThinkingDelta("New ", 0),
        claudeThinkingDelta("thought", 0),
        claudeAssistantSnapshot("msg-B", [thought("New thought")]),
      ],
      expected: [
        reasoning("Hello "),
        reasoning("Hello world", "world"),
        reasoning("New "),
        reasoning("New thought", "thought"),
      ],
    },
    {
      name: "ignores indexless thinking deltas without content block framing",
      frames: [claudeThinkingDelta("orphaned"), claudeThinkingDelta("also orphaned", "0")],
      expected: [],
    },
  ])("$name", ({ frames, expected }) => {
    const { parser, thinking } = createClaudeTaggedReasoningHarness({ onAssistantDelta: () => {} });

    finishCliFrames(parser, ...frames);

    expect(thinking).toEqual(expected);
  });

  it("emits token progress for Claude CLI 2.1 empty thinking deltas", () => {
    const progress: CliThinkingProgress[] = [];
    const { parser, thinking } = createClaudeTaggedReasoningHarness({
      backend: { ...localBackend, command: "claude" },
      providerId: "claude-cli",
      onAssistantDelta: () => {},
      onThinkingProgress: (payload) => progress.push(payload),
    });

    parser.push(readFileSync("test/fixtures/cli/claude-2.1-thinking-progress.jsonl", "utf8"));
    parser.finish();

    expect(thinking).toEqual([]);
    expect(progress).toEqual([
      { progressTokens: 50, modelProgress: true },
      { progressTokens: 200, modelProgress: true },
      { progressTokens: 300, modelProgress: true },
    ]);
  });
});
