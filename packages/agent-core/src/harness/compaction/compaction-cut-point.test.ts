import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { estimateTokens, findCutPoint } from "./compaction.js";
import { createMessageEntry as entry } from "./compaction.test-support.js";
import { assistant, toolCall, toolResult, user } from "./shard-fixtures.test-support.js";

const call = (name = "bash", id = "call-1") =>
  assistant([{ ...toolCall(name, {}, id), async: true }], {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    timestamp: 2,
    stopReason: "toolUse",
  });
const result = (text: string, overrides: Partial<ReturnType<typeof toolResult>> = {}) =>
  toolResult(text, { toolName: "bash", timestamp: 4, ...overrides });
function exchange(edit: (messages: AgentMessage[]) => void = () => {}) {
  const messages: AgentMessage[] = [
    user("Run the lookup and explain the approach."),
    call(),
    assistant("Independent explanation. ".repeat(50), { timestamp: 3 }),
    result("The actual lookup result is 7319."),
    assistant("Done.", { timestamp: 5 }),
  ];
  edit(messages);
  return messages.map(entry);
}
const cut = (
  entries: SessionTreeEntry[],
  tokens = 100,
  options?: Parameters<typeof findCutPoint>[4],
) => findCutPoint(entries, 0, entries.length, tokens, options);

describe("findCutPoint", () => {
  it.each([
    ["late result", exchange(), false, 1],
    [
      "completed exchange before explanation",
      exchange((m) => {
        m.splice(
          2,
          2,
          result("The actual lookup result is 7319."),
          assistant("Independent explanation. ".repeat(50), { timestamp: 3 }),
        );
      }),
      false,
      3,
    ],
    ["completed exchange exceeds budget", exchange(), true, 4],
    [
      "incomplete exchange exceeds budget",
      exchange((m) => {
        m.pop();
      }),
      true,
      4,
    ],
    [
      "reused provider id",
      exchange((m) => {
        m.splice(1, 0, call(), result("Earlier completed result.", { timestamp: 2 }));
      }),
      false,
      3,
    ],
    [
      "late replacement of synthetic result",
      exchange((m) => {
        m.splice(2, 0, {
          ...result("Missing result.", { timestamp: 2 }),
          isError: true,
          details: { openclawSyntheticMissingToolResult: true },
        });
      }),
      false,
      1,
    ],
    [
      "overlapping calls finishing out of order",
      exchange((m) => {
        m.splice(2, 0, call("read", "call-2"));
        m.splice(
          4,
          0,
          result("Second call finished first.", { toolCallId: "call-2", toolName: "read" }),
        );
      }),
      false,
      1,
    ],
  ] as const)("handles %s", (name, entries, budgeted, kept) => {
    const maxTokens = entries
      .slice(2)
      .reduce((sum, e) => sum + (e.type === "message" ? estimateTokens(e.message) : 0), 0);
    const actual = cut(
      [...entries],
      100,
      budgeted ? { budget: { maxTokens, reserveTokens: 0, estimateTokens } } : undefined,
    );
    expect(actual.firstKeptEntryIndex).toBe(kept);
    if (name === "late result") {
      expect(actual.isSplitTurn).toBe(true);
    }
  });
  it("retains an older call across a pending user message", () => {
    const entries = exchange((m) => {
      m.splice(3, 0, user("Please preserve this pending request.", 3));
    });
    expect(cut(entries, 1, { preserveFromEntryId: "entry-3" }).firstKeptEntryIndex).toBe(1);
  });
  it("preserves the pending suffix before a foreground budget exists", () => {
    const entries = [
      user("processed request"),
      assistant("processed answer", { timestamp: 2 }),
      user("first admitted input", 3),
      user("later admitted input", 4),
    ].map(entry);
    expect(cut(entries, 1).firstKeptEntryIndex).toBe(3);
    expect(cut(entries, 1, { preserveFromEntryId: "entry-2" })).toEqual({
      firstKeptEntryIndex: 2,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });
  const large = "x".repeat(120_000);
  it.each([
    ["text", result(large, { timestamp: 5 }), false],
    [
      "Codex toolResult text",
      {
        ...toolResult([], { toolName: "codex_progress", timestamp: 5 }),
        content: [
          {
            id: "call-1",
            toolUseId: "call-1",
            type: "toolResult",
            content: "duplicate",
            text: large,
          },
        ],
      } as unknown as AgentMessage,
      true,
    ],
    [
      "snake-case tool_result content",
      {
        ...toolResult([], { toolName: "codex_progress", timestamp: 5 }),
        content: [{ id: "call-1", toolUseId: "call-1", type: "tool_result", content: large }],
      } as unknown as AgentMessage,
      true,
    ],
  ] as const)("counts and cuts large %s output", (_name, trailing, nested) => {
    const entries = [
      user("start of the conversation"),
      assistant("first reply", { timestamp: 2 }),
      user("please run the command", 3),
      assistant("running it now", { timestamp: 4 }),
      trailing,
    ].map(entry);
    if (nested) {
      expect(estimateTokens(trailing)).toBeGreaterThanOrEqual(20_000);
    }
    expect(cut(entries, 20_000).firstKeptEntryIndex).toBe(3);
  });
});
