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
const omitted = assistant([text("[tool calls omitted]")]);

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
    role: "toolResult",
    toolUseId: "tool-1",
    toolName: "gateway",
    content: [text("done")],
    isError: false,
  };
  const source = { ...assistant(signed()), stopReason: "toolUse" };
  const injected = {
    ...assistant([text("Subagent completion delivered.")]),
    stopReason: "stop",
  };
  expect(
    validateAnthropicTurns(asMessages([user("Use tool"), source, injected, result]), {
      mergeConsecutiveTurns: false,
    }),
  ).toEqual([user("Use tool"), source, injected, result]);
});

it.each([true, false])(
  "merges string users or backfills array-user timestamps (explicit=%s)",
  (explicitTime) => {
    const before = explicitTime ? { role: "user", content: "before" } : user("before");
    const after = explicitTime
      ? { role: "user", content: "after", timestamp: 2000 }
      : user("after");
    expect(validateAnthropicTurns(asMessages([{ ...before, timestamp: 1000 }, after]))).toEqual([
      {
        ...user([text("before"), text("after")]),
        timestamp: explicitTime ? 2000 : 1000,
      },
    ]);
  },
);

it("repairs dangling tool-only turns after abort", () => {
  checkToolTurn([call("toolUse")], [user("Hello")], [], { stopReason: "aborted" });
});

it("prunes only unmatched sibling calls with user-embedded results", () => {
  const following = user([
    { type: "toolResult", toolUseId: "tool-1", content: [text("Result 1")] },
    text("Thanks"),
  ]);
  checkToolTurn(
    [call("toolUse"), call("toolUse", "tool-2"), text("Done")],
    [following],
    [call("toolUse"), text("Done")],
  );
});

it("matches legacy results across intermediate non-assistant turns", () => {
  const following = [
    user("waiting"),
    { role: "tool", toolCallId: "tool-1", content: [text("data")] },
    user("Continue"),
  ];
  const content = [call("functionCall"), text("Checking")];
  checkToolTurn(content, following, content);
});

it.each(["embedded", "wrong-name"])("rejects signed pairing with %s results", (kind) => {
  const embedded = kind === "embedded";
  const content = embedded ? [thinking, call("toolUse")] : signed();
  const following = embedded
    ? [
        {
          role: "user",
          content: [
            { type: "toolResult", toolUseId: "tool-1", content: [text("ok")] },
            text("Continue"),
          ],
        },
      ]
    : [textToolResult("tool-1", "exec", "wrong tool", { isError: false }), user("Continue")];
  checkToolTurn(content, following, omitted.content);
});
