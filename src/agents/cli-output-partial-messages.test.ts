import { describe, expect, it } from "vitest";
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
  ] as const)("keeps the ordinary frame limit for %s", (_name, record) => {
    const parser = createParser();
    parser.push(line(record, 20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
  });

  it("keeps the ordinary frame limit when a custom parser claims deltas", () => {
    const parser = createClaudeParser({
      parseJsonlEvent: () => ({ kind: "text", text: "a" }),
    });
    parser.push(line(streamDelta({ type: "text_delta", text: "a" }), 20_001));
    expect(parser.getErrorText()).toContain("exceeded 20000 lines");
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
});
