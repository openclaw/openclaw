import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { ContextDecayConfig } from "../../config/types.agent-defaults.js";
import type { GroupSummaryStore, SummaryStore } from "./summary-store.js";
import {
  findEligibleWindows,
  buildGroupSummarizationPrompt,
  type TurnWindow,
} from "./group-summarizer.js";
import { computeTurnAges } from "./turn-ages.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUser(text: string): AgentMessage {
  return { role: "user", content: text, timestamp: Date.now() };
}

function makeAssistant(text: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    stopReason: "stop",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeAssistantWithToolUse(toolCallId: string, toolName: string): AgentMessage {
  return {
    role: "assistant",
    content: [
      { type: "text", text: "Let me call a tool." },
      { type: "tool_use", id: toolCallId, name: toolName, input: { path: "/src/foo.ts" } },
    ],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    stopReason: "tool_use",
    timestamp: Date.now(),
  } as AgentMessage;
}

function makeToolResult(toolCallId: string, toolName: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: Date.now(),
  };
}

// Pad to ensure token estimates clear the MIN_WINDOW_TOKENS (500) threshold.
const PAD = " ".repeat(400);

/**
 * Build a multi-turn conversation with N turns, each containing user + assistant + tool call.
 * Returns messages array suitable for testing.
 */
function buildConversation(turnCount: number): AgentMessage[] {
  const messages: AgentMessage[] = [];
  for (let i = 0; i < turnCount; i++) {
    messages.push(
      makeUser(
        `User message for turn ${i} with some context about what needs to be done in this step of the conversation.${PAD}`,
      ),
    );
    messages.push(makeAssistantWithToolUse(`call_${i}`, `tool_${i}`));
    messages.push(
      makeToolResult(
        `call_${i}`,
        `tool_${i}`,
        `Result for turn ${i}: found the file at /src/module-${i}.ts with function handle${i}() that processes the data correctly and returns the expected output.${PAD}`,
      ),
    );
  }
  // Final turn (current)
  messages.push(makeUser("Latest user message"));
  messages.push(makeAssistant("Latest assistant response"));
  return messages;
}

// ---------------------------------------------------------------------------
// Tests: findEligibleWindows
// ---------------------------------------------------------------------------

describe("findEligibleWindows", () => {
  it("returns empty when summarizeWindowAfterTurns is not set", () => {
    const messages = buildConversation(8);
    const config: ContextDecayConfig = {};
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    expect(result).toEqual([]);
  });

  it("returns empty when no turns meet the age threshold", () => {
    const messages = buildConversation(3);
    const config: ContextDecayConfig = { summarizeWindowAfterTurns: 10 };
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    expect(result).toEqual([]);
  });

  it("returns empty when fewer than 2 eligible turns exist", () => {
    // 2 history turns + 1 current = turn ages 0, 1, 2
    // With threshold 2, only turn age 2 qualifies → not enough for a window
    const messages = buildConversation(2);
    messages.push(makeUser("current"));
    messages.push(makeAssistant("current response"));
    const config: ContextDecayConfig = { summarizeWindowAfterTurns: 100 };
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    expect(result).toEqual([]);
  });

  it("finds windows when enough turns meet the age threshold", () => {
    const messages = buildConversation(8);
    // Turn ages: 8,8,8, 7,7,7, 6,6,6, 5,5,5, 4,4,4, 3,3,3, 2,2,2, 1,1,1, 0,0
    // With threshold 3, turns 3-8 are eligible (6 turns)
    // Default window size 4: should create 1 full window + leftover < 2 skipped
    const config: ContextDecayConfig = { summarizeWindowAfterTurns: 3, summarizeWindowSize: 4 };
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    expect(result.length).toBeGreaterThanOrEqual(1);
    for (const win of result) {
      expect(win.indices.length).toBeGreaterThan(0);
      expect(win.anchorIndex).toBeDefined();
      expect(win.turnRange).toHaveLength(2);
    }
  });

  it("respects custom window size", () => {
    const messages = buildConversation(10);
    const config: ContextDecayConfig = { summarizeWindowAfterTurns: 2, summarizeWindowSize: 2 };
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    // With window size 2, we should get multiple windows
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it("excludes turns already covered by existing group summaries", () => {
    const messages = buildConversation(8);
    const config: ContextDecayConfig = { summarizeWindowAfterTurns: 3, summarizeWindowSize: 4 };

    // First call: get the windows
    const firstResult = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    expect(firstResult.length).toBeGreaterThanOrEqual(1);

    // Simulate that the first window was already summarized
    const existingGroupSummaries: GroupSummaryStore = [
      {
        summary: "Already summarized",
        anchorIndex: firstResult[0].anchorIndex,
        indices: firstResult[0].indices,
        turnRange: firstResult[0].turnRange,
        originalTokenEstimate: 500,
        summaryTokenEstimate: 50,
        summarizedAt: new Date().toISOString(),
        model: "test",
      },
    ];

    // Second call: those turns should be excluded
    const secondResult = findEligibleWindows({
      messages,
      config,
      existingGroupSummaries,
    });

    // The previously summarized indices should not appear in any new window
    const coveredIndices = new Set(firstResult[0].indices);
    for (const win of secondResult) {
      for (const idx of win.indices) {
        expect(coveredIndices.has(idx)).toBe(false);
      }
    }
  });

  it("excludes turns past stripToolResultsAfterTurns", () => {
    const messages = buildConversation(10);
    const config: ContextDecayConfig = {
      summarizeWindowAfterTurns: 3,
      stripToolResultsAfterTurns: 7,
      summarizeWindowSize: 4,
    };
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    // No window should include turns with age >= 7
    for (const win of result) {
      expect(win.turnRange[0]).toBeLessThan(7);
    }
  });

  it("sets anchor to first user message in window", () => {
    const messages = buildConversation(8);
    const config: ContextDecayConfig = { summarizeWindowAfterTurns: 3, summarizeWindowSize: 4 };
    const result = findEligibleWindows({ messages, config, existingGroupSummaries: [] });
    for (const win of result) {
      // The anchor should be in the window's indices
      expect(win.indices).toContain(win.anchorIndex);
      // The anchor should be a user message
      expect(messages[win.anchorIndex].role).toBe("user");
    }
  });
});

// ---------------------------------------------------------------------------
// Tests: buildGroupSummarizationPrompt
// ---------------------------------------------------------------------------

describe("buildGroupSummarizationPrompt", () => {
  it("includes header instruction", () => {
    const messages = buildConversation(4);
    const turnAges = computeTurnAges(messages);
    const win: TurnWindow = {
      turnRange: [3, 2],
      indices: [0, 1, 2, 3, 4, 5],
      anchorIndex: 0,
    };
    const prompt = buildGroupSummarizationPrompt({
      messages,
      window: win,
      turnAges,
      individualSummaries: {},
    });
    expect(prompt).toContain("Summarize this conversation window");
    expect(prompt).toContain("causal chains");
  });

  it("includes user, assistant, and tool result content", () => {
    const messages = buildConversation(4);
    const turnAges = computeTurnAges(messages);
    const win: TurnWindow = {
      turnRange: [3, 2],
      indices: [0, 1, 2, 3, 4, 5],
      anchorIndex: 0,
    };
    const prompt = buildGroupSummarizationPrompt({
      messages,
      window: win,
      turnAges,
      individualSummaries: {},
    });
    expect(prompt).toContain("[User]:");
    expect(prompt).toContain("[Assistant]:");
    expect(prompt).toContain("[Tool:");
  });

  it("uses individual summaries when available instead of raw content", () => {
    const messages = buildConversation(4);
    const turnAges = computeTurnAges(messages);
    const individualSummaries: SummaryStore = {
      2: {
        summary: "Individual summary of tool result 0",
        originalTokenEstimate: 100,
        summaryTokenEstimate: 10,
        summarizedAt: new Date().toISOString(),
        model: "haiku",
      },
    };
    const win: TurnWindow = {
      turnRange: [3, 2],
      indices: [0, 1, 2, 3, 4, 5],
      anchorIndex: 0,
    };
    const prompt = buildGroupSummarizationPrompt({
      messages,
      window: win,
      turnAges,
      individualSummaries,
    });
    expect(prompt).toContain("[Previously summarized]");
    expect(prompt).toContain("Individual summary of tool result 0");
  });

  it("includes turn age markers", () => {
    const messages = buildConversation(4);
    const turnAges = computeTurnAges(messages);
    const win: TurnWindow = {
      turnRange: [3, 2],
      indices: [0, 1, 2, 3, 4, 5],
      anchorIndex: 0,
    };
    const prompt = buildGroupSummarizationPrompt({
      messages,
      window: win,
      turnAges,
      individualSummaries: {},
    });
    expect(prompt).toContain("--- Turn [age");
  });

  it("truncates very long prompts", () => {
    // Build messages with very long content
    const messages: AgentMessage[] = [];
    const longContent = "x".repeat(60_000);
    messages.push(makeUser(longContent));
    messages.push(makeAssistant(longContent));
    messages.push(makeUser("current"));
    messages.push(makeAssistant("current"));
    const turnAges = computeTurnAges(messages);
    const win: TurnWindow = {
      turnRange: [1, 1],
      indices: [0, 1],
      anchorIndex: 0,
    };
    const prompt = buildGroupSummarizationPrompt({
      messages,
      window: win,
      turnAges,
      individualSummaries: {},
    });
    expect(prompt.length).toBeLessThanOrEqual(100_020); // MAX_PROMPT_CHARS + "\n[truncated]"
    expect(prompt).toContain("[truncated]");
  });
});
