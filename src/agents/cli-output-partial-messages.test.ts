import { describe, expect, it } from "vitest";
import { chargeClaudeStreamJsonLine } from "./cli-output-stream-limits.js";
import {
  claudeBlockStart,
  claudeBlockStop,
  createClaudeParser,
} from "./cli-output.test-helpers.js";

const text = { type: "text_delta", text: "a" };
const input = { type: "input_json_delta", partial_json: "{" };
const thinking = { type: "thinking_delta", thinking: "a" };
const limits = {
  uuid: 128,
  session_id: 128,
  parent_tool_use_id: 128,
  api_message_id: 64,
  thinking_display: 32,
};
function frame(delta: Record<string, unknown>, metadata: Record<string, unknown> = {}) {
  return {
    type: "stream_event",
    event: { type: "content_block_delta", index: 0, delta },
    session_id: "00000000-0000-4000-8000-000000000001",
    parent_tool_use_id: null,
    uuid: "00000000-0000-4000-8000-000000000002",
    api_message_id: `msg_${"0".repeat(24)}`,
    ...metadata,
  };
}
const line = (record: unknown) => `${JSON.stringify(record)}\n`;
const parserFor = (custom = false) =>
  createClaudeParser({
    onThinkingDelta: () => {},
    ...(custom ? { parseJsonlEvent: () => ({ kind: "text" as const, text: "a" }) } : {}),
  });

describe("Claude partial-message output budgets", () => {
  it.each([
    { name: "envelope characters", count: 18_000, chars: 128, resultChars: 2_000_000 },
    { name: "delta frames", count: 20_001, chars: 1, resultChars: 0 },
  ])("completes tool turns beyond raw $name limits", ({ count, chars, resultChars }) => {
    const inputs: unknown[] = [];
    const parser = createClaudeParser({ onToolUseStart: (tool) => inputs.push(tool.args) });
    const push = (record: unknown) => parser.push(line(record));
    const value = "a".repeat(count * chars),
      tool = { type: "tool_use", id: "write-fixture", name: "Write", input: { value } };
    push(claudeBlockStart({ ...tool, input: {} }, 0));
    push(frame({ ...input, partial_json: '{"value":"' }));
    parser.push(line(frame({ ...input, partial_json: "a".repeat(chars) })).repeat(count));
    push(frame({ ...input, partial_json: '"}' }));
    push(claudeBlockStop(0));
    push({ type: "assistant", message: { id: "tool-message", content: [tool] } });
    push({
      type: "user",
      message: {
        content: [{ type: "tool_result", tool_use_id: tool.id, content: "r".repeat(resultChars) }],
      },
    });
    push({
      type: "assistant",
      message: { id: "final-message", content: [{ type: "text", text: "completed" }] },
    });
    push({ type: "result", subtype: "success", result: "completed" });
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.hasTerminalResult()).toBe(true);
    expect(parser.getOutput()?.text).toBe("completed");
    expect(inputs).toEqual([{ value }]);
  });

  const records: Array<
    [string, Record<string, unknown>, Record<string, unknown>, number | null | "custom"]
  > = [
    ["current text", { ...text, text: "Ac" }, {}, 36],
    ["current tool input", { ...input, partial_json: '{"pa' }, {}, 39],
    [
      "thinking token estimate",
      { ...thinking, estimated_tokens: 50 },
      { thinking_display: "updates" },
      58,
    ],
    ["null metadata", text, { api_message_id: null, thinking_display: null }, 35],
    [
      "display without API id",
      thinking,
      { api_message_id: undefined, thinking_display: "updates" },
      35,
    ],
    ["captured 2.1.296 text", { ...text, text: "x" }, {}, 35],
    [
      "captured 2.1.310 thinking",
      { ...thinking, thinking: "xxx", estimated_tokens: null },
      { thinking_display: "updates" },
      62,
    ],
    ["unfinished legacy text", text, { api_message_id: undefined }, 35],
    [
      "unfinished legacy thinking",
      { ...thinking, estimated_tokens: null },
      { api_message_id: undefined },
      60,
    ],
    ["empty text", { ...text, text: "" }, {}, null],
    [
      "empty thinking progress",
      { ...thinking, thinking: "", estimated_tokens: 50 },
      { thinking_display: "updates" },
      null,
    ],
    ["signature delta", { type: "signature_delta", signature: "s" }, {}, null],
    ["unknown delta field", { ...text, extra: true }, {}, null],
    ["unknown record field", text, { request_id: "req_1" }, null],
    ["display on text", text, { thinking_display: "updates" }, null],
    ["display on tool input", input, { thinking_display: "updates" }, null],
    ["custom parser", text, {}, "custom"],
  ];
  for (const [key, cap] of Object.entries(limits)) {
    const delta = key === "thinking_display" ? thinking : text;
    records.push([`${key} at cap`, delta, { [key]: "m".repeat(cap) }, 35]);
    records.push([`${key} over cap`, delta, { [key]: "m".repeat(cap + 1) }, null]);
    records.push([`${key} wrong type`, delta, { [key]: 7 }, null]);
  }
  it.each(records)(
    "accounts for %s before applying the ordinary-line budget",
    (_name, delta, metadata, chars) => {
      const raw = JSON.stringify(frame(delta, metadata)),
        custom = chars === "custom";
      if (!custom) {
        expect(chargeClaudeStreamJsonLine(JSON.parse(raw), raw)).toEqual({
          chars: chars ?? raw.length,
          partialMessage: chars !== null,
        });
      }
      const parser = parserFor(custom);
      parser.push(`${raw}\n`.repeat(20_001));
      parser.finish();
      if (chars === null || custom) {
        expect(parser.getErrorText()).toContain("exceeded 20000 lines");
      } else {
        expect(parser.getErrorText()).toBeNull();
        if (!metadata.parent_tool_use_id && delta.type !== "input_json_delta") {
          expect(parser.getOutput()).not.toBeNull();
          if (typeof delta.text === "string") {
            expect(parser.getOutput()?.text).toBe(delta.text.repeat(20_001));
          }
        }
      }
    },
  );

  it.each([
    ["encoded text", () => line(frame({ ...text, text: "a".repeat(4_300_000) }))],
    ["encoded tool input", () => line(frame({ ...input, partial_json: '"'.repeat(2_150_000) }))],
    ["outer whitespace", () => " ".repeat(4_300_000) + line(frame(text))],
  ] as const)("bounds %s before retaining output", (_name, makeChunk) => {
    const parser = parserFor(),
      chunk = makeChunk();
    parser.push(chunk);
    expect(parser.getErrorText()).toBeNull();
    parser.push(chunk);
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(parser.getOutput()?.text).toBe("");
  });

  it.each([
    ["legacy tool input", input, { api_message_id: undefined }],
    [
      "maximal current thinking",
      thinking,
      Object.fromEntries(Object.entries(limits).map(([key, cap]) => [key, "m".repeat(cap)])),
    ],
  ] as const)("bounds tiny %s floods without ordinary frames", (_name, delta, metadata) => {
    const parser = parserFor(),
      chunk = line(frame(delta, metadata));
    let frames = 0;
    for (; frames < 240_000 && !parser.getErrorText(); frames += 1) {
      parser.push(chunk);
    }
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(frames).toBe(233_017);
  });
});
