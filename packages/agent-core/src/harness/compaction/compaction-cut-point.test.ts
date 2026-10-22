import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { estimateTokens, findCutPoint } from "./compaction.js";
import { createMessageEntry as messageEntry } from "./compaction.test-support.js";
import { assistant, text, toolCall, toolResult, user } from "./shard-fixtures.test-support.js";

const KEEP_RECENT_TOKENS = 20000;
const LARGE_TOOL_OUTPUT = "x".repeat(120000);

const userText = (content: string, timestamp: number) => user([text(content)], timestamp);

const assistantText = (content: string, timestamp: number) =>
  assistant(content, {
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    timestamp,
  });

const toolResultText = (content: string, timestamp: number) =>
  toolResult(content, { toolName: "bash", timestamp });
const callingAssistant = (name: string, id: string): AgentMessage => ({
  ...assistantText("", 2),
  content: [{ ...toolCall(name, {}, id), async: true }],
  stopReason: "toolUse",
});

function nestedToolResult(
  block: { type: string; content?: unknown; text?: string },
  timestamp: number,
): AgentMessage {
  return {
    ...toolResult([], { toolName: "codex_progress", timestamp }),
    content: [{ id: "call-1", toolUseId: "call-1", ...block }],
  } as unknown as AgentMessage;
}

function buildTranscriptWithToolResult(
  result: AgentMessage = toolResultText(LARGE_TOOL_OUTPUT, 5),
): SessionTreeEntry[] {
  return [
    userText("start of the conversation", 1),
    assistantText("first reply", 2),
    userText("please run the command", 3),
    assistantText("running it now", 4),
    result,
  ].map(messageEntry);
}

describe("findCutPoint", () => {
  const cut = (
    entries: SessionTreeEntry[],
    tokens = 100,
    options?: Parameters<typeof findCutPoint>[4],
  ) => findCutPoint(entries, 0, entries.length, tokens, options);
  function foregroundBudget(entries: SessionTreeEntry[]) {
    const maxTokens = entries
      .slice(2)
      .reduce(
        (total, entry) => total + (entry.type === "message" ? estimateTokens(entry.message) : 0),
        0,
      );
    return { budget: { maxTokens, reserveTokens: 0, estimateTokens } };
  }

  function asynchronousMessages(resultBeforeText = false): AgentMessage[] {
    const progress = assistantText("Independent explanation. ".repeat(50), 3);
    const result = toolResultText("The actual lookup result is 7319.", 4);
    return [
      userText("Run the lookup and explain the approach.", 1),
      callingAssistant("bash", "call-1"),
      ...(resultBeforeText ? [result, progress] : [progress, result]),
      assistantText("Done.", 5),
    ];
  }
  const asynchronousExchange = (resultBeforeText = false) =>
    asynchronousMessages(resultBeforeText).map(messageEntry);

  it.each([
    ["late result", false, false, false, 1],
    ["completed exchange before explanation", true, false, false, 3],
    ["completed exchange exceeds budget", false, false, true, 4],
    ["incomplete exchange exceeds budget", false, true, true, 4],
  ] as const)("cuts an async tail with %s", (_name, resultFirst, incomplete, budgeted, kept) => {
    const entries = asynchronousExchange(resultFirst).slice(0, incomplete ? -1 : undefined);
    const result = cut(entries, 100, budgeted ? foregroundBudget(entries) : undefined);
    expect(result.firstKeptEntryIndex).toBe(kept);
    if (kept === 1) {
      expect(result.isSplitTurn).toBe(true);
    }
  });

  it("keeps an older call when a pending user message arrives before its result", () => {
    const messages = asynchronousMessages();
    messages.splice(3, 0, userText("Please preserve this pending request.", 3));
    const entries = messages.map(messageEntry);

    expect(cut(entries, 1, { preserveFromEntryId: "entry-3" }).firstKeptEntryIndex).toBe(1);
  });

  it("does not pull a previous completed occurrence with a reused provider id into the tail", () => {
    const messages = asynchronousMessages();
    const earlierCall = messages[1];
    if (earlierCall?.role !== "assistant") {
      throw new Error("The fixture is missing its tool-calling assistant");
    }
    messages.splice(
      1,
      0,
      structuredClone(earlierCall),
      toolResultText("Earlier completed result.", 2),
    );
    const entries = messages.map(messageEntry);

    expect(cut(entries).firstKeptEntryIndex).toBe(3);
  });

  it("keeps the real late result with the call whose synthetic result it replaces", () => {
    const messages = asynchronousMessages();
    messages.splice(2, 0, {
      ...toolResultText("Missing result.", 2),
      isError: true,
      details: { openclawSyntheticMissingToolResult: true },
    });
    const entries = messages.map(messageEntry);

    expect(cut(entries).firstKeptEntryIndex).toBe(1);
  });

  it("keeps overlapping asynchronous calls and out-of-order results in one retained group", () => {
    const messages = asynchronousMessages();
    messages.splice(2, 0, callingAssistant("read", "call-2"));
    messages.splice(4, 0, {
      ...toolResultText("Second call finished first.", 4),
      toolCallId: "call-2",
      toolName: "read",
    });
    const entries = messages.map(messageEntry);

    expect(cut(entries).firstKeptEntryIndex).toBe(1);
  });

  it("preserves the pending suffix before a foreground budget exists", () => {
    const pending = messageEntry(userText("first admitted input", 3), 2);
    const entries = [
      messageEntry(userText("processed request", 1), 0),
      messageEntry(assistantText("processed answer", 2), 1),
      pending,
      messageEntry(userText("later admitted input", 4), 3),
    ];
    expect(cut(entries, 1).firstKeptEntryIndex).toBe(3);
    expect(cut(entries, 1, { preserveFromEntryId: pending.id })).toEqual({
      firstKeptEntryIndex: 2,
      turnStartIndex: -1,
      isSplitTurn: false,
    });
  });

  it("trims the prefix instead of keeping the whole transcript", () => {
    const entries = buildTranscriptWithToolResult();

    const result = cut(entries, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBe(3);
  });

  it.each([
    {
      name: "Codex toolResult text",
      block: { type: "toolResult", content: "duplicate", text: LARGE_TOOL_OUTPUT },
    },
    {
      name: "snake-case tool_result content",
      block: { type: "tool_result", content: LARGE_TOOL_OUTPUT },
    },
  ])("counts and trims the prefix for $name", ({ block }) => {
    const trailing = nestedToolResult(block, 5);
    const entries = buildTranscriptWithToolResult(trailing);

    expect(estimateTokens(trailing)).toBeGreaterThanOrEqual(KEEP_RECENT_TOKENS);
    const result = cut(entries, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBe(3);
  });
});
