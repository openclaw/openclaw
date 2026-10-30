import { expect, it } from "vitest";
import { validateAnthropicTurns, validateGeminiTurns } from "./embedded-agent-helpers/turns.js";
import { castAgentMessages as asMessages } from "./test-helpers/agent-message-fixtures.js";
import { textToolResult } from "./test-helpers/sparse-transcript.test-support.js";

const text = (value: string) => ({ type: "text", text: value });
const user = (value: string | unknown[]) => ({
  role: "user",
  content: typeof value === "string" ? [text(value)] : value,
});
const assistant = (content: unknown[]) => ({ role: "assistant", content });
const call = (type: string, id = "tool-1") => ({ type, id, name: "gateway", arguments: {} });
const thinking = { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" };
const signed = () => [thinking, call("toolCall")];
const resultBlock = (value: string) => ({
  type: "toolResult",
  toolUseId: "tool-1",
  content: [text(value)],
});

function checkToolTurn(content: unknown[], following: unknown[], expected: unknown[], fields = {}) {
  const wrap = (blocks: unknown[]) =>
    asMessages([user("Use tool"), { ...assistant(blocks), ...fields }, ...following]);
  expect(validateAnthropicTurns(wrap(content))).toEqual(wrap(expected));
}

it("returns empty history unchanged", () => {
  expect(validateGeminiTurns([])).toStrictEqual([]);
  expect(validateAnthropicTurns([])).toStrictEqual([]);
});

it("merges Gemini assistant content with the latest usage and stop reason", () => {
  const latest = { usage: { input: 10, output: 10 }, stopReason: "end_turn" };
  const messages = asMessages([
    { ...assistant([text("Part 1")]), usage: { input: 10, output: 5 } },
    { ...assistant([text("Part 2")]), ...latest },
  ]);
  expect(validateGeminiTurns(messages)).toEqual([
    { ...assistant([text("Part 1"), text("Part 2")]), ...latest },
  ]);
});

it("preserves signed tool-result pairing across an injected assistant without merging", () => {
  const result = {
    ...resultBlock("done"),
    role: "toolResult",
    toolName: "gateway",
    isError: false,
  };
  const source = { ...assistant(signed()), stopReason: "toolUse" };
  const injected = { ...assistant([text("delivered")]), stopReason: "stop" };
  expect(
    validateAnthropicTurns(asMessages([user("Use tool"), source, injected, result]), {
      mergeConsecutiveTurns: false,
    }),
  ).toEqual([user("Use tool"), source, injected, result]);
});

it("backfills merged array-user timestamps", () => {
  expect(
    validateAnthropicTurns(asMessages([{ ...user("before"), timestamp: 1000 }, user("after")])),
  ).toEqual([{ ...user([text("before"), text("after")]), timestamp: 1000 }]);
});

const legacy = [call("functionCall"), text("Checking")];
const omitted = [text("[tool calls omitted]")];
it.each<[string, unknown[], unknown[], unknown[], Record<string, unknown>?]>([
  ["aborted dangling call", [call("toolUse")], [user("Hello")], [], { stopReason: "aborted" }],
  [
    "unmatched sibling",
    [call("toolUse"), call("toolUse", "tool-2"), text("Done")],
    [user([resultBlock("Result 1"), text("Thanks")])],
    [call("toolUse"), text("Done")],
  ],
  [
    "legacy result after a user",
    legacy,
    [
      user("waiting"),
      { role: "tool", toolCallId: "tool-1", content: [text("data")] },
      user("Continue"),
    ],
    legacy,
  ],
  [
    "signed embedded result",
    [thinking, call("toolUse")],
    [user([resultBlock("ok"), text("Continue")])],
    omitted,
  ],
  [
    "signed wrong-name result",
    signed(),
    [textToolResult("tool-1", "exec", "wrong tool", { isError: false }), user("Continue")],
    omitted,
  ],
])("repairs %s", (_name, content, following, expected, fields) => {
  checkToolTurn(content, following, expected, fields);
});
