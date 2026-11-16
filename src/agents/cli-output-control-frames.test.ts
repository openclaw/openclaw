import { describe, expect, it } from "vitest";
import { chargeClaudeStreamJsonLine } from "./cli-output-stream-limits.js";
import { createClaudeParser } from "./cli-output.test-helpers.js";

// Record shapes from Claude Code 2.1.296 stream-json output; ids are synthetic.
const METADATA = {
  session_id: "22222222-2222-4222-8222-222222222222",
  parent_tool_use_id: null,
  uuid: "11111111-1111-4111-8111-111111111111",
  api_message_id: `msg_${"0".repeat(24)}`,
};
const frame = (event: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  type: "stream_event",
  event,
  ...METADATA,
  ...extra,
});
const progress = (extra: Record<string, unknown> = {}, estimated_tokens: number | null = 50) =>
  frame(
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "thinking_delta", thinking: "", estimated_tokens },
    },
    { thinking_display: "updates", ...extra },
  );
const signature = (chars = 2_300) =>
  frame({
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "s".repeat(chars) },
  });
const blockStop = () => frame({ type: "content_block_stop", index: 0 });
const messageStop = () => frame({ type: "message_stop" });
const messageDelta = () =>
  frame({
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null, stop_details: null, container: null },
    usage: {
      input_tokens: 2,
      output_tokens: 8998,
      output_tokens_details: { thinking_tokens: 5497 },
    },
    context_management: { applied_edits: [] },
  });

const charge = (record: Record<string, unknown>, rawLine = JSON.stringify(record)) =>
  chargeClaudeStreamJsonLine(record, rawLine);
const fullCharge = (record: Record<string, unknown>) => {
  const rawLine = JSON.stringify(record);
  return { chars: rawLine.length, partialMessage: false };
};
const line = (record: unknown, count = 1) => `${JSON.stringify(record)}\n`.repeat(count);
const PROGRESS_CHARS = 32 + '{"estimated_tokens":50}'.length;
const ALLOWANCE = 8 * 1024;

describe("Claude stream control-frame budgets", () => {
  it.each([
    ["thinking progress", progress(), PROGRESS_CHARS, true],
    [
      "null-estimate thinking progress",
      progress({}, null),
      32 + '{"estimated_tokens":null}'.length,
      true,
    ],
    ["content_block_stop", blockStop(), 32, true],
    ["message_stop", messageStop(), 32, true],
    ["signature_delta", signature(), 32, false],
    ["message_delta", messageDelta(), 32, false],
  ] as const)("charges a %s frame a fixed allowance", (_name, record, chars, partialMessage) => {
    expect(JSON.stringify(record).length).toBeGreaterThan(200);
    expect(charge(record)).toEqual({ chars, partialMessage });
  });

  it.each([
    ["content_block_stop", blockStop(), 32],
    ["thinking progress", progress(), PROGRESS_CHARS],
  ])("keeps wire whitespace around a %s frame", (_name, record, chars) => {
    expect(charge(record, `   ${JSON.stringify(record)}  `).chars).toBe(chars + 5);
  });

  it.each([
    [
      "index-less thinking progress",
      { ...progress(), event: { type: "content_block_delta", delta: progress().event.delta } },
      PROGRESS_CHARS,
    ],
    ["index-less content_block_stop", frame({ type: "content_block_stop" }), 32],
    [
      "child-attributed content_block_stop",
      { ...blockStop(), parent_tool_use_id: "toolu_child" },
      32,
    ],
    ["child-attributed signature_delta", { ...signature(), parent_tool_use_id: "toolu_child" }, 32],
  ])("charges a fixed allowance for the %s frame", (_name, record, chars) => {
    expect(charge(record).chars).toBe(chars);
  });

  it.each([
    ["signature_delta", (extra: number) => signature(extra)],
    [
      "message_delta",
      (extra: number) => ({
        ...messageDelta(),
        event: { ...messageDelta().event, usage: { pad: "u".repeat(extra) } },
      }),
    ],
  ])("charges a %s line for content beyond its 8 KiB allowance", (_name, build) => {
    const base = JSON.stringify(build(0)).length;
    const atAllowance = build(ALLOWANCE - base);
    expect(JSON.stringify(atAllowance).length).toBe(ALLOWANCE);
    expect(charge(atAllowance)).toEqual({ chars: 32, partialMessage: false });
    expect(charge(build(ALLOWANCE - base + 100)).chars).toBe(32 + 100);
    expect(charge(build(4 * 1024 * 1024)).chars).toBe(32 + 4 * 1024 * 1024 + base - ALLOWANCE);
    const record = build(10);
    const padding = " ".repeat(ALLOWANCE * 2);
    expect(charge(record, `${padding}${JSON.stringify(record)}`).chars).toBe(32 + padding.length);
  });

  it.each([
    ["an unknown record key", { ...blockStop(), request_id: "r" }],
    ["an unknown event key", frame({ type: "content_block_stop", index: 0, extra: 1 })],
    ["an unknown message_delta key", frame({ type: "message_delta", delta: {}, content: [] })],
    [
      "an unknown progress delta key",
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "", estimated_tokens: 50, extra: 1 },
      }),
    ],
    [
      "an unknown signature delta key",
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "s", extra: 1 },
      }),
    ],
    [
      "a non-numeric estimate",
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "", estimated_tokens: "50" },
      }),
    ],
    [
      "a missing estimate",
      frame({
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "" },
      }),
    ],
    ["an empty signature", signature(0)],
    ["a negative index", frame({ type: "content_block_stop", index: -1 })],
    ["a string index", frame({ type: "content_block_stop", index: "0" })],
    ["a non-string api_message_id", { ...blockStop(), api_message_id: 7 }],
    ["an oversized thinking_display", progress({ thinking_display: "d".repeat(33) })],
    ["thinking_display outside progress", { ...signature(), thinking_display: "updates" }],
    ["an inherited key name", { ...blockStop(), constructor: "x" }],
    ["a message_start frame", frame({ type: "message_start", message: { id: "m" } })],
    ["a content_block_start frame", frame({ type: "content_block_start", index: 0 })],
  ])("keeps full accounting for %s", (_name, record) => {
    expect(charge(record)).toEqual(fullCharge(record));
  });

  it("keeps the payload charge for a thinking delta with text", () => {
    const record = progress();
    Object.assign(record.event.delta as Record<string, unknown>, { thinking: "t".repeat(10_000) });
    expect(charge(record).chars).toBeGreaterThan(10_000);
  });

  it.each([
    ["uuid", 128],
    ["session_id", 128],
    ["parent_tool_use_id", 128],
    ["api_message_id", 64],
  ])("accepts %s up to %i characters", (key, limit) => {
    expect(charge({ ...blockStop(), [key]: "m".repeat(limit) }).chars).toBe(32);
    const over = { ...blockStop(), [key]: "m".repeat(limit + 1) };
    expect(charge(over)).toEqual(fullCharge(over));
  });

  it("accepts thinking_display up to 32 characters", () => {
    expect(charge(progress({ thinking_display: "d".repeat(32) })).partialMessage).toBe(true);
  });

  it("keeps full accounting for an estimate that overflows on the wire", () => {
    const rawLine = JSON.stringify(progress()).replace(
      '"estimated_tokens":50',
      '"estimated_tokens":1e999',
    );
    expect(chargeClaudeStreamJsonLine(JSON.parse(rawLine), rawLine)).toEqual({
      chars: rawLine.length,
      partialMessage: false,
    });
  });

  it("leaves thinking progress and tool starts to the parser", () => {
    const tokens: number[] = [];
    const tools: string[] = [];
    const parser = createClaudeParser({
      onThinkingProgress: ({ progressTokens }) => tokens.push(progressTokens),
      onThinkingDelta: () => {},
      onToolUseStart: (tool) => tools.push(tool.name),
    });
    const start = frame({
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "tool-1", name: "Read", input: {} },
    });
    const stop = frame({ type: "content_block_stop", index: 1 });
    parser.push(line(progress(), 3) + line(start) + line(stop));
    parser.finish();
    expect(tokens).toEqual([50, 100, 150]);
    expect(tools).toEqual(["Read"]);
  });

  it.each([
    ["thinking progress", progress()],
    ["content_block_stop", blockStop()],
    ["message_stop", messageStop()],
  ])("completes more than 20,000 %s frames", (_name, record) => {
    const parser = createClaudeParser({ onThinkingProgress: () => {} });
    parser.push(line(record, 20_001));
    parser.push(line({ type: "result", subtype: "success", result: "done" }));
    parser.finish();
    expect(parser.getErrorText()).toBeNull();
    expect(parser.getOutput()?.text).toBe("done");
  });

  it("stops discarded frames at the allowance on the 20,001st line", () => {
    const sig = signature(ALLOWANCE - JSON.stringify(signature(0)).length);
    const padded = messageDelta();
    const usage = { ...(padded.event.usage as object), pad: "" };
    padded.event.usage = usage;
    usage.pad = "p".repeat(ALLOWANCE - JSON.stringify(padded).length);
    const sigLine = line(sig);
    const deltaLine = line(padded);
    expect([sigLine.length - 1, deltaLine.length - 1]).toEqual([ALLOWANCE, ALLOWANCE]);
    expect(charge(sig)).toEqual({ chars: 32, partialMessage: false });
    expect(charge(padded)).toEqual({ chars: 32, partialMessage: false });
    const parser = createClaudeParser();
    for (let index = 0; index < 20_000; index += 1) {
      parser.push(index % 2 === 0 ? sigLine : deltaLine);
    }
    expect(parser.getErrorText()).toBeNull();
    parser.push(sigLine);
    expect(parser.getErrorText()).toBe(
      "CLI JSONL output exceeded 20000 lines; refusing to parse output.",
    );
  });

  it.each([
    ["thinking progress", progress(), PROGRESS_CHARS],
    ["content_block_stop", blockStop(), 32],
    ["message_stop", messageStop(), 32],
  ])("bounds a flood of %s frames by the character budget", (_name, record, chars) => {
    const parser = createClaudeParser({ onThinkingProgress: () => {} });
    const chunk = line(record);
    let frames = 0;
    while (!parser.getErrorText() && frames < 300_000) {
      parser.push(chunk);
      frames += 1;
    }
    expect(parser.getErrorText()).toContain("exceeded 8388608 characters");
    expect(frames).toBe(Math.floor((8 * 1024 * 1024) / (chars + 1)) + 1);
  });
});
