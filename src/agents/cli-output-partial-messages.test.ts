import { describe, expect, it } from "vitest";
import { chargeClaudeStreamJsonLine } from "./cli-output-stream-limits.js";
import {
  claudeBlockStart,
  claudeBlockStop,
  createClaudeParser,
} from "./cli-output.test-helpers.js";

function streamDelta(delta: Record<string, unknown>) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    uuid: "11111111-1111-4111-8111-111111111111",
    session_id: "22222222-2222-4222-8222-222222222222",
    parent_tool_use_id: null,
  };
}

// Frame metadata shape emitted by current Claude Code (seen on 2.1.296 and 2.1.310).
const API_MESSAGE_ID = `msg_${"0".repeat(24)}`;
const currentDelta = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  ...streamDelta(delta),
  api_message_id: API_MESSAGE_ID,
  ...extra,
});
const CURRENT_FRAMES = [
  ["text_delta", currentDelta({ type: "text_delta", text: "Ac" })],
  ["input_json_delta", currentDelta({ type: "input_json_delta", partial_json: '{"pa' })],
  [
    "thinking_delta",
    currentDelta(
      { type: "thinking_delta", thinking: "a", estimated_tokens: 50 },
      { thinking_display: "updates" },
    ),
  ],
  [
    "null metadata",
    currentDelta(
      { type: "text_delta", text: "a" },
      { api_message_id: null, thinking_display: null },
    ),
  ],
  [
    "thinking_display only",
    { ...streamDelta({ type: "thinking_delta", thinking: "a" }), thinking_display: "updates" },
  ],
  [
    "api_message_id at its cap",
    currentDelta({ type: "text_delta", text: "a" }, { api_message_id: "m".repeat(64) }),
  ],
  [
    "thinking_display at its cap",
    currentDelta({ type: "thinking_delta", thinking: "a" }, { thinking_display: "d".repeat(32) }),
  ],
] as const;

// Key order and field values of captured frames, with synthetic ids.
const capturedFrame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta },
  session_id: "00000000-0000-4000-8000-000000000001",
  parent_tool_use_id: null,
  uuid: "00000000-0000-4000-8000-000000000002",
  ...extra,
  api_message_id: API_MESSAGE_ID,
});

const createParser = () => createClaudeParser({ onThinkingDelta: () => {} });
const line = (record: unknown, count = 1) => `${JSON.stringify(record)}\n`.repeat(count);

describe("Claude partial-message output budgets", () => {
  it.each([
    { name: "envelope characters", count: 18_000, chars: 128, resultChars: 2_000_000 },
    { name: "delta frames", count: 20_001, chars: 1, resultChars: 0 },
  ])("completes tool turns beyond raw $name limits", ({ count, chars, resultChars }) => {
    const inputs: unknown[] = [];
    const parser = createClaudeParser({ onToolUseStart: (tool) => inputs.push(tool.args) });
    const push = (record: unknown) => parser.push(line(record));
    const input = { value: "a".repeat(count * chars) };
    const tool = { type: "tool_use", id: "write-fixture", name: "Write", input };
    push(claudeBlockStart({ ...tool, input: {} }, 0));
    push(streamDelta({ type: "input_json_delta", partial_json: '{"value":"' }));
    const partial_json = "a".repeat(chars);
    const chunk = line(streamDelta({ type: "input_json_delta", partial_json }));
    for (let index = 0; index < count; index += 1) {
      parser.push(chunk);
    }
    push(streamDelta({ type: "input_json_delta", partial_json: '"}' }));
    push(claudeBlockStop(0));
    push({ type: "assistant", message: { id: "tool-message", content: [tool] } });
    const content = "r".repeat(resultChars);
    const result = { type: "tool_result", tool_use_id: tool.id, content };
    push({ type: "user", message: { content: [result] } });
    const final = { id: "final-message", content: [{ type: "text", text: "completed" }] };
    push({ type: "assistant", message: final });
    push({ type: "result", subtype: "success", result: "completed" });
    parser.finish();

    expect(parser.getErrorText()).toBeNull();
    expect(parser.hasTerminalResult()).toBe(true);
    expect(parser.getOutput()?.text).toBe("completed");
    expect(inputs).toEqual([input]);
  });

  it.each([
    { type: "text_delta", field: "text", payload: "a".repeat(4_300_000) },
    { type: "input_json_delta", field: "partial_json", payload: '"'.repeat(2_150_000) },
  ])("still bounds encoded $type payloads", ({ type, field, payload }) => {
    const parser = createParser();
    const chunk = line(streamDelta({ type, [field]: payload }));
    parser.push(chunk);
    expect(parser.getErrorText()).toBeNull();
    parser.push(chunk);
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(parser.getOutput()?.text).toBe("");
  });

  it.each([
    { type: "text_delta", text: "a" },
    { type: "thinking_delta", thinking: "a", estimated_tokens: null },
  ])("accepts a long $type stream without a terminal frame", (delta) => {
    const parser = createParser();
    parser.push(line(streamDelta(delta), 20_001));
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()).not.toBeNull();
    if (delta.type === "text_delta") {
      expect(parser.getOutput()?.text).toBe("a".repeat(20_001));
    }
  });

  it.each([
    ["empty deltas", streamDelta({ type: "text_delta", text: "" })],
    ["unknown delta fields", streamDelta({ type: "text_delta", text: "a", extra: true })],
    [
      "oversized metadata",
      { ...streamDelta({ type: "text_delta", text: "a" }), uuid: "u".repeat(129) },
    ],
    ["custom parser", streamDelta({ type: "text_delta", text: "a" })],
  ] as const)("keeps the ordinary frame limit for %s", (name, record) => {
    const parser =
      name === "custom parser"
        ? createClaudeParser({ parseJsonlEvent: () => ({ kind: "text", text: "a" }) })
        : createParser();
    parser.push(line(record, 20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it.each(CURRENT_FRAMES)("discounts the envelope of a current %s frame", (_name, record) => {
    const raw = JSON.stringify(record);
    const delta = record.event.delta as Record<string, unknown>;
    const payload = delta.text ?? delta.partial_json ?? delta.thinking;
    const tokens = delta.estimated_tokens === undefined ? 0 : '{"estimated_tokens":50}'.length;
    expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
      chars: JSON.stringify(payload).length + 32 + tokens,
      partialMessage: true,
    });
  });

  it.each(CURRENT_FRAMES)("accepts 20,001 current %s frames", (_name, record) => {
    const parser = createParser();
    parser.push(line(record, 20_001));
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
  });

  it.each([
    [
      "oversized api_message_id",
      currentDelta({ type: "text_delta", text: "a" }, { api_message_id: "m".repeat(65) }),
    ],
    [
      "non-string api_message_id",
      currentDelta({ type: "text_delta", text: "a" }, { api_message_id: 7 }),
    ],
    [
      "oversized thinking_display",
      currentDelta({ type: "thinking_delta", thinking: "a" }, { thinking_display: "d".repeat(33) }),
    ],
    [
      "non-string thinking_display",
      currentDelta({ type: "thinking_delta", thinking: "a" }, { thinking_display: 7 }),
    ],
    [
      "thinking_display on a text frame",
      currentDelta({ type: "text_delta", text: "a" }, { thinking_display: "updates" }),
    ],
    [
      "thinking_display on a tool-input frame",
      currentDelta(
        { type: "input_json_delta", partial_json: "{" },
        { thinking_display: "updates" },
      ),
    ],
    [
      "unknown record fields",
      currentDelta({ type: "text_delta", text: "a" }, { request_id: "req_1" }),
    ],
  ] as const)("keeps full accounting for %s", (_name, record) => {
    const raw = JSON.stringify(record);
    expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
      chars: raw.length,
      partialMessage: false,
    });
    const parser = createParser();
    parser.push(line(record, 20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it.each([
    ["2.1.296 text_delta", capturedFrame({ type: "text_delta", text: "x" }), 35],
    [
      "2.1.310 thinking_delta",
      capturedFrame(
        { type: "thinking_delta", thinking: "xxx", estimated_tokens: null },
        { thinking_display: "updates" },
      ),
      62,
    ],
  ] as const)("discounts a captured %s frame", (_name, record, chars) => {
    const raw = JSON.stringify(record);
    expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
      chars,
      partialMessage: true,
    });
  });

  it("keeps full accounting for a captured empty thinking progress frame", () => {
    const record = capturedFrame(
      { type: "thinking_delta", thinking: "", estimated_tokens: 50 },
      { thinking_display: "updates" },
    );
    const raw = JSON.stringify(record);
    expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
      chars: raw.length,
      partialMessage: false,
    });
  });

  it("still counts outer whitespace around a recognized delta", () => {
    const parser = createParser();
    const compact = JSON.stringify(streamDelta({ type: "text_delta", text: "a" }));
    const padding = " ".repeat(4_300_000);
    const padded = padding + compact;
    parser.push(`${padded}\n${padded}\n`);
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
  });

  it("bounds tiny nonempty delta floods even without ordinary frames", () => {
    const parser = createParser();
    const chunk = line(streamDelta({ type: "input_json_delta", partial_json: "a" }));
    for (let index = 0; index < 262_145 && !parser.getErrorText(); index += 1) {
      parser.push(chunk);
    }
    expect(parser.getErrorText()).toContain("CLI JSONL output exceeded");
  });

  it("bounds tiny current-metadata delta floods by characters", () => {
    const record = currentDelta(
      { type: "thinking_delta", thinking: "a" },
      {
        uuid: "u".repeat(128),
        session_id: "s".repeat(128),
        parent_tool_use_id: "p".repeat(128),
        api_message_id: "m".repeat(64),
        thinking_display: "d".repeat(32),
      },
    );
    const parser = createParser();
    const chunk = line(record);
    // Each frame is charged 35 characters plus its newline, so frame 233,017 overflows.
    let frames = 0;
    for (; frames < 240_000 && !parser.getErrorText(); frames += 1) {
      parser.push(chunk);
    }
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(frames).toBe(233_017);
  });
});
