import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { estimateTokens, findCutPoint } from "./compaction.js";

const KEEP_RECENT_TOKENS = 20000;
const LARGE_TOOL_OUTPUT = "x".repeat(120000);

function userText(text: string, timestamp: number): AgentMessage {
  return { role: "user", content: [{ type: "text", text }], timestamp };
}

function assistantText(
  text: string,
  timestamp: number,
): Extract<AgentMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "claude-fable-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  };
}

function toolResultText(
  text: string,
  timestamp: number,
): Extract<AgentMessage, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function nestedToolResult(
  block: { type: string; content?: unknown; text?: string },
  timestamp: number,
): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "codex_progress",
    content: [
      {
        id: "call-1",
        toolUseId: "call-1",
        ...block,
      },
    ],
    isError: false,
    timestamp,
  } as unknown as AgentMessage;
}

function messageEntry(message: AgentMessage, index: number): SessionTreeEntry {
  return {
    type: "message",
    id: `entry-${index}`,
    parentId: index === 0 ? null : `entry-${index - 1}`,
    timestamp: new Date(message.timestamp).toISOString(),
    message,
  };
}

function buildTranscript(): SessionTreeEntry[] {
  return buildTranscriptWithToolResult(toolResultText(LARGE_TOOL_OUTPUT, 5));
}

function buildTranscriptWithToolResult(toolResult: AgentMessage): SessionTreeEntry[] {
  const messages: AgentMessage[] = [
    userText("start of the conversation", 1),
    assistantText("first reply", 2),
    userText("please run the command", 3),
    assistantText("running it now", 4),
    toolResult,
  ];
  return messages.map((message, index) => messageEntry(message, index));
}

describe("findCutPoint", () => {
  function asynchronousExchange(resultBeforeText = false): SessionTreeEntry[] {
    const call: AgentMessage = {
      ...assistantText("", 2),
      content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {}, async: true }],
      stopReason: "toolUse",
    };
    const progress = assistantText("Independent explanation. ".repeat(50), 3);
    const result = toolResultText("The actual lookup result is 7319.", 4);
    return [
      userText("Run the lookup and explain the approach.", 1),
      call,
      ...(resultBeforeText ? [result, progress] : [progress, result]),
      assistantText("Done.", 5),
    ].map(messageEntry);
  }

  it("retains an async call whose result follows another assistant fragment", () => {
    const entries = asynchronousExchange();
    const result = findCutPoint(entries, 0, entries.length, 100);

    expect(result.firstKeptEntryIndex).toBe(1);
    expect(result.isSplitTurn).toBe(true);
  });

  it("can summarize a completed tool exchange before the retained explanation", () => {
    const entries = asynchronousExchange(true);

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(3);
  });

  it("summarizes the complete exchange when its call cannot fit the foreground budget", () => {
    const entries = asynchronousExchange();
    const maxTokens = entries.slice(2).reduce((total, entry) => {
      return total + (entry.type === "message" ? estimateTokens(entry.message) : 0);
    }, 0);

    expect(
      findCutPoint(entries, 0, entries.length, 100, {
        budget: { maxTokens, reserveTokens: 0, estimateTokens },
      }).firstKeptEntryIndex,
    ).toBe(4);
  });

  it("refuses a foreground tail that can only fit an incomplete tool exchange", () => {
    const entries = asynchronousExchange().slice(0, -1);
    const maxTokens = entries.slice(2).reduce((total, entry) => {
      return total + (entry.type === "message" ? estimateTokens(entry.message) : 0);
    }, 0);

    expect(
      findCutPoint(entries, 0, entries.length, 100, {
        budget: { maxTokens, reserveTokens: 0, estimateTokens },
      }).firstKeptEntryIndex,
    ).toBe(entries.length);
  });

  it("keeps an older call when a pending user message arrives before its result", () => {
    const messages = asynchronousExchange().flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
    messages.splice(3, 0, userText("Please preserve this pending request.", 3));
    const entries = messages.map(messageEntry);

    expect(
      findCutPoint(entries, 0, entries.length, 1, { preserveFromEntryId: "entry-3" })
        .firstKeptEntryIndex,
    ).toBe(1);
  });

  it("does not pull a previous completed occurrence with a reused provider id into the tail", () => {
    const messages = asynchronousExchange().flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
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

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(3);
  });

  it("keeps the real late result with the call whose synthetic result it replaces", () => {
    const messages = asynchronousExchange().flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
    messages.splice(2, 0, {
      ...toolResultText("Missing result.", 2),
      isError: true,
      details: { openclawSyntheticMissingToolResult: true },
    });
    const entries = messages.map(messageEntry);

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(1);
  });

  it("keeps overlapping asynchronous calls and out-of-order results in one retained group", () => {
    const messages = asynchronousExchange().flatMap((entry) =>
      entry.type === "message" ? [entry.message] : [],
    );
    messages.splice(2, 0, {
      ...assistantText("", 2),
      content: [{ type: "toolCall", id: "call-2", name: "read", arguments: {}, async: true }],
      stopReason: "toolUse",
    });
    messages.splice(4, 0, {
      ...toolResultText("Second call finished first.", 4),
      toolCallId: "call-2",
      toolName: "read",
    });
    const entries = messages.map(messageEntry);

    expect(findCutPoint(entries, 0, entries.length, 100).firstKeptEntryIndex).toBe(1);
  });

  it("preserves the pending suffix before a foreground budget exists", () => {
    const pending = messageEntry(userText("first admitted input", 3), 2);
    const entries = [
      messageEntry(userText("processed request", 1), 0),
      messageEntry(assistantText("processed answer", 2), 1),
      pending,
      messageEntry(userText("later admitted input", 4), 3),
    ];
    expect(findCutPoint(entries, 0, entries.length, 1).firstKeptEntryIndex).toBe(3);
    expect(
      findCutPoint(entries, 0, entries.length, 1, { preserveFromEntryId: pending.id }),
    ).toEqual({ firstKeptEntryIndex: 2, turnStartIndex: -1, isSplitTurn: false });
  });

  it("trims the prefix instead of keeping the whole transcript", () => {
    const entries = buildTranscript();

    const result = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
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
    const result = findCutPoint(entries, 0, entries.length, KEEP_RECENT_TOKENS);

    expect(result.firstKeptEntryIndex).toBeGreaterThan(0);
    expect(result.firstKeptEntryIndex).toBe(3);
  });
});
