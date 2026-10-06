import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { validateAnthropicTurns, validateGeminiTurns } from "./embedded-agent-helpers.js";
import { textToolResult } from "./test-helpers/sparse-transcript.test-support.js";

function asMessages(messages: unknown[]): AgentMessage[] {
  return messages as AgentMessage[];
}
const text = (value: string) => ({ type: "text", text: value });
const user = (value: string) => ({ role: "user", content: [text(value)] });
const assistant = (content: unknown[]) => ({ role: "assistant", content });
const call = (type: string, id = "tool-1", name = "gateway") => ({ type, id, name, arguments: {} });
const thinking = { type: "thinking", thinking: "internal", thinkingSignature: "sig_1" };
const signed = (id = "tool-1") => [thinking, call("toolCall", id)];
const omitted = assistant([text("[tool calls omitted]")]);

function validateToolTurn(content: unknown[], following: unknown[], fields = {}) {
  return validateAnthropicTurns(
    asMessages([user("Use tool"), { ...assistant(content), ...fields }, ...following]),
  );
}

describe("turn validation", () => {
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

  it("does not merge Gemini turns across tool results", () => {
    const prefix = [
      { role: "user", content: "Use tool" },
      assistant([call("toolUse")]),
      { role: "toolResult", toolUseId: "tool-1", content: [text("Found data")] },
    ];
    expect(
      validateGeminiTurns(
        asMessages([
          ...prefix,
          assistant([text("Answer")]),
          assistant([text("Extra")]),
          user("Next"),
        ]),
      ),
    ).toEqual([...prefix, assistant([text("Answer"), text("Extra")]), user("Next")]);
  });

  it("keeps consecutive users separate when merging is disabled", () => {
    const messages = asMessages([
      user("Switch model"),
      user("Read notes.txt"),
      assistant([text("Done")]),
    ]);
    expect(validateAnthropicTurns(messages, { mergeConsecutiveUserTurns: false })).toEqual(
      messages,
    );
  });

  it("keeps newest user metadata while merging ordered content", () => {
    const latest = {
      timestamp: 2000,
      attachments: [{ type: "image", url: "new.png" }],
      someCustomField: "keep-me",
    };
    expect(
      validateAnthropicTurns(
        asMessages([
          { ...user("Old"), timestamp: 1000, attachments: [{ type: "image", url: "old.png" }] },
          { ...user("New"), ...latest },
        ]),
      ),
    ).toEqual([{ role: "user", content: [text("Old"), text("New")], ...latest }]);
  });

  it("merges injected assistant turns before checking signed tool-result pairing", () => {
    const result = {
      role: "toolResult",
      toolUseId: "tool-1",
      toolName: "gateway",
      content: [text("done")],
      isError: false,
    };
    expect(
      validateToolTurn(
        signed(),
        [{ ...assistant([text("Subagent completion delivered.")]), stopReason: "stop" }, result],
        { stopReason: "toolUse" },
      ),
    ).toEqual([
      user("Use tool"),
      { ...assistant([...signed(), text("Subagent completion delivered.")]), stopReason: "stop" },
      result,
    ]);
  });

  it("normalizes string user content while merging", () => {
    expect(
      validateAnthropicTurns(
        asMessages([
          { role: "user", content: "before", timestamp: 1000 },
          { role: "user", content: "after", timestamp: 2000 },
        ]),
      ),
    ).toEqual([{ role: "user", content: [text("before"), text("after")], timestamp: 2000 }]);
  });

  it("backfills missing user timestamps from the preceding turn", () => {
    expect(
      validateAnthropicTurns(asMessages([{ ...user("before"), timestamp: 1000 }, user("after")])),
    ).toEqual([{ role: "user", content: [text("before"), text("after")], timestamp: 1000 }]);
  });

  it.each([
    { stopReason: "stop", expected: [text("[tool calls omitted]")] },
    { stopReason: "aborted", expected: [] },
  ])("repairs dangling tool-only turns after $stopReason", ({ stopReason, expected }) => {
    expect(validateToolTurn([call("toolUse")], [user("Hello")], { stopReason })).toEqual([
      user("Use tool"),
      { role: "assistant", content: expected, stopReason },
      user("Hello"),
    ]);
  });

  it("prunes only unmatched sibling calls with user-embedded results", () => {
    const following = {
      role: "user",
      content: [
        { type: "toolResult", toolUseId: "tool-1", content: [text("Result 1")] },
        text("Thanks"),
      ],
    };
    expect(
      validateToolTurn([call("toolUse"), call("toolUse", "tool-2"), text("Done")], [following]),
    ).toEqual([user("Use tool"), assistant([call("toolUse"), text("Done")]), following]);
  });

  it("matches legacy results across intermediate non-assistant turns", () => {
    const following = [
      user("waiting"),
      { role: "tool", toolCallId: "tool-1", content: [text("data")] },
      user("Continue"),
    ];
    const content = [call("functionCall"), text("Checking")];
    expect(validateToolTurn(content, following)).toEqual([
      user("Use tool"),
      assistant(content),
      ...following,
    ]);
  });

  it("does not trust user-embedded results for signed thinking", () => {
    const following = {
      role: "user",
      content: [
        { type: "toolResult", toolUseId: "tool-1", content: [text("ok")] },
        text("Continue"),
      ],
    };
    expect(validateToolTurn([thinking, call("toolUse")], [following])).toEqual([
      user("Use tool"),
      omitted,
      following,
    ]);
  });

  it("accepts a current tool-result alias alongside a stale alias", () => {
    const following = [
      {
        ...textToolResult("tool-current", "gateway", "ok", { isError: false }),
        toolUseId: "tool-stale",
      },
      user("Continue"),
    ];
    expect(validateToolTurn(signed("tool-current"), following)).toEqual([
      user("Use tool"),
      assistant(signed("tool-current")),
      ...following,
    ]);
  });

  it("rejects signed-thinking pairing with the wrong tool name", () => {
    const following = [
      textToolResult("tool-1", "exec", "wrong tool", { isError: false }),
      user("Continue"),
    ];
    expect(validateToolTurn(signed(), following)).toEqual([
      user("Use tool"),
      omitted,
      ...following,
    ]);
  });

  it("drops redacted thinking when its sibling call is dangling", () => {
    expect(
      validateToolTurn(
        [{ type: "redacted_thinking", data: "blob", thinkingSignature: "sig_1" }, call("toolUse")],
        [user("Continue")],
      ),
    ).toEqual([user("Use tool"), omitted, user("Continue")]);
  });
});
