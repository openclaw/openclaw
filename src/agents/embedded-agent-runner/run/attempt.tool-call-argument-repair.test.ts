import { describe, expect, it } from "vitest";
import { wrapStreamFnTextTransforms } from "../../plugin-text-transforms.js";
import {
  collectStreamEvents,
  createFakeStream,
  type FakeWrappedStream,
} from "./attempt-stream.test-helpers.js";
import {
  shouldRepairMalformedToolCallArguments,
  wrapStreamFnRepairMalformedToolCallArguments,
} from "./attempt.tool-call-argument-repair.js";

type FakeStreamFn = (
  model: never,
  context: never,
  options: never,
) => FakeWrappedStream | Promise<FakeWrappedStream>;

async function repair(deltas: string[], name: string, transform = false) {
  const type = transform ? "toolCall" : "functionCall";
  const calls = Array.from({ length: 4 }, () => ({ type, name, arguments: {} }));
  const partial = { role: "assistant", content: [calls[0]] };
  const finalMessage = { role: "assistant", content: [calls[3]] };
  const baseFn: FakeStreamFn = () =>
    createFakeStream({
      events: [
        ...deltas.map((delta) => ({ type: "toolcall_delta", contentIndex: 0, delta, partial })),
        {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: calls[1],
          partial,
          message: { role: "assistant", content: [calls[2]] },
        },
      ],
      resultMessage: finalMessage,
    });
  const repaired = wrapStreamFnRepairMalformedToolCallArguments(baseFn as never);
  const wrapped = (
    transform
      ? wrapStreamFnTextTransforms({
          streamFn: repaired,
          output: [{ from: /\[MASKED\]/g, to: "John Smith" }],
        })
      : repaired
  ) as FakeStreamFn;
  const stream = await wrapped({} as never, {} as never, {} as never);
  const events = await collectStreamEvents(stream);
  return { calls, events, result: await stream.result(), finalMessage };
}

describe("malformed tool-call argument repair", () => {
  it.each([
    ["kimi", "anthropic-messages", true],
    ["kimi-coding", "anthropic-messages", false],
    ["openai", "openai-chatgpt-responses", true],
  ] as const)("gates %s / %s repair", (provider, modelApi, expected) => {
    expect(shouldRepairMalformedToolCallArguments({ provider, modelApi })).toBe(expected);
  });

  it("restores split replacement tokens after argument repair", async () => {
    const { result, events } = await repair(['{"text":"[MAS', 'KED]"}'], "send", true);
    expect(
      events
        .filter((event) => (event as { type?: string }).type === "toolcall_delta")
        .map((event) => (event as { delta?: string }).delta),
    ).toEqual(['{"text":"[MAS', 'KED]"}']);
    expect(
      events.find((event) => (event as { type?: string }).type === "toolcall_end"),
    ).toMatchObject({ toolCall: { arguments: { text: "John Smith" } } });
    expect(result).toMatchObject({ content: [{ arguments: { text: "John Smith" } }] });
  });

  it.each([
    {
      name: "fragmented JSON with preamble and trailing junk",
      tool: "read",
      deltas: [".functions.read:0 ", '{"path":"/tmp/report.txt"', "}x"],
      expected: { path: "/tmp/report.txt" },
    },
    {
      name: "smart-quoted edit arrays",
      tool: "edit",
      deltas: [
        String.raw` {“path”:“notes/报告.md”,“edits”:[{“oldText”:“旧的 **草稿**”,“newText”:“更新 \"草稿\"\nnext”},{“oldText”:“tail”,“newText”:“done”}]}`,
      ],
      expected: {
        path: "notes/报告.md",
        edits: [
          { oldText: "旧的 **草稿**", newText: '更新 "草稿"\nnext' },
          { oldText: "tail", newText: "done" },
        ],
      },
    },
    {
      name: "prefixless case-varied read options",
      tool: "Read",
      deltas: ["{“path”:“safe.txt”,“offset”:5,“limit”:20}"],
      expected: { path: "safe.txt", offset: 5, limit: 20 },
    },
    {
      name: "structured tool name overriding a mismatched prefix",
      tool: "grep",
      deltas: [
        ".functions.read:0 ",
        String.raw` {“pattern”:“Use ”, “limit”: “bar” in prose”,“path”:“safe.txt”}`,
      ],
      expected: { pattern: "Use ”, “limit”: “bar” in prose", path: "safe.txt" },
    },
    {
      name: "inherited tool-name successor rejection",
      tool: "constructor",
      deltas: ["{“length”:“x”,“foo”:1}"],
      expected: {},
    },
    {
      name: "JSON escapes in smart-quoted content",
      tool: "write",
      deltas: [
        String.raw` {“path”:“safe.txt”,“content”:“line\nnext \"quoted\" path C:\\tmp mark \u2713 invalid \d”}`,
      ],
      expected: {
        path: "safe.txt",
        content: 'line\nnext "quoted" path C:\\tmp mark ✓ invalid \\d',
      },
    },
    {
      name: "member-looking prose in mixed ASCII-key content",
      tool: "write",
      deltas: [String.raw` {"path":"safe.txt","content":“text ”, “path”: “other.txt””}`],
      expected: { path: "safe.txt", content: "text ”, “path”: “other.txt”" },
    },
  ])("repairs $name across partial, end and final messages", async ({ deltas, tool, expected }) => {
    const { calls, result, finalMessage } = await repair(deltas, tool);
    expect(result).toBe(finalMessage);
    for (const call of calls) {
      expect(call.arguments).toEqual(expected);
    }
  });
});
