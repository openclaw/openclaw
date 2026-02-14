import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import type { SwappedFileStore } from "../../context-decay/file-store.js";
import type { SummaryStore } from "../../context-decay/summary-store.js";
import { applyContextDecay } from "./decay.js";

/**
 * Build a minimal transcript: user → assistant(tool_use) → toolResult, repeated per turn.
 * Final user message = current turn.
 */
function buildTranscript(turnCount: number): AgentMessage[] {
  const msgs: AgentMessage[] = [];
  for (let t = 0; t < turnCount; t++) {
    msgs.push({ role: "user", content: `Turn ${t}`, timestamp: Date.now() } as AgentMessage);
    msgs.push({
      role: "assistant",
      content: [
        { type: "text", text: "Checking..." },
        { type: "tool_use", id: `call-${t}`, name: "Read", input: {} },
      ],
      timestamp: Date.now(),
    } as unknown as AgentMessage);
    msgs.push({
      role: "toolResult",
      toolCallId: `call-${t}`,
      content: [{ type: "text", text: `Result for turn ${t} with lots of content` }],
      timestamp: Date.now(),
    } as unknown as AgentMessage);
  }
  // Current turn user message
  msgs.push({ role: "user", content: "Current", timestamp: Date.now() } as AgentMessage);
  return msgs;
}

describe("applyContextDecay — file swap step", () => {
  it("replaces tool result content with file path + hint", () => {
    const messages = buildTranscript(5);
    // toolResult indices: 2, 5, 8, 11, 14 (every 3rd starting from 2)
    const swappedFileStore: SwappedFileStore = {
      2: {
        filePath: "/tmp/results/1700000000-Read.txt",
        toolName: "Read",
        hint: "[50 lines, TypeScript] function foo()",
        originalChars: 2000,
        swappedAt: "2026-01-15T10:00:00Z",
      },
    };

    const result = applyContextDecay({
      messages,
      config: { swapToolResultsAfterTurns: 2 },
      summaryStore: {},
      swappedFileStore,
    });

    // Index 2 should have swapped content
    const swapped = result[2] as unknown as { content: Array<{ text: string }> };
    expect(swapped.content[0].text).toContain("[Tool result saved to /tmp/results/1700000000-Read.txt]");
    expect(swapped.content[0].text).toContain("[50 lines, TypeScript] function foo()");
  });

  it("summary takes precedence over swap when both exist", () => {
    const messages = buildTranscript(5);
    const swappedFileStore: SwappedFileStore = {
      2: {
        filePath: "/tmp/results/test.txt",
        toolName: "Read",
        hint: "Swap hint",
        originalChars: 2000,
        swappedAt: "2026-01-15T10:00:00Z",
      },
    };
    const summaryStore: SummaryStore = {
      2: {
        summary: "LLM summary of the tool result",
        originalTokenEstimate: 500,
        summaryTokenEstimate: 20,
        summarizedAt: "2026-01-15T10:01:00Z",
        model: "haiku",
      },
    };

    const result = applyContextDecay({
      messages,
      config: {
        swapToolResultsAfterTurns: 2,
        summarizeToolResultsAfterTurns: 3,
      },
      summaryStore,
      swappedFileStore,
    });

    // Index 2 (age 5) is past summarize threshold AND has a summary → summary wins
    const content = result[2] as unknown as { content: Array<{ text: string }> };
    expect(content.content[0].text).toContain("[Summarized]");
    expect(content.content[0].text).not.toContain("[Tool result saved to");
  });

  it("strip takes precedence over swap", () => {
    const messages = buildTranscript(5);
    const swappedFileStore: SwappedFileStore = {
      2: {
        filePath: "/tmp/results/test.txt",
        toolName: "Read",
        hint: "Swap hint",
        originalChars: 2000,
        swappedAt: "2026-01-15T10:00:00Z",
      },
    };

    const result = applyContextDecay({
      messages,
      config: {
        swapToolResultsAfterTurns: 2,
        stripToolResultsAfterTurns: 3,
      },
      summaryStore: {},
      swappedFileStore,
    });

    // Index 2 (age 5) is past strip threshold → strip wins
    const content = result[2] as unknown as { content: Array<{ text: string }> };
    expect(content.content[0].text).toContain("[Tool result removed");
    expect(content.content[0].text).not.toContain("[Tool result saved to");
  });

  it("does not apply swap when store is empty", () => {
    const messages = buildTranscript(3);
    const result = applyContextDecay({
      messages,
      config: { swapToolResultsAfterTurns: 1 },
      summaryStore: {},
      swappedFileStore: {},
    });

    // No changes — original messages returned
    expect(result).toBe(messages);
  });

  it("does not apply swap to messages below age threshold", () => {
    const messages = buildTranscript(3);
    // Index 8 = turn 2 = age 1 (below threshold of 2)
    const swappedFileStore: SwappedFileStore = {
      8: {
        filePath: "/tmp/results/recent.txt",
        toolName: "Read",
        hint: "Recent result",
        originalChars: 500,
        swappedAt: "2026-01-15T10:00:00Z",
      },
    };

    const result = applyContextDecay({
      messages,
      config: { swapToolResultsAfterTurns: 2 },
      summaryStore: {},
      swappedFileStore,
    });

    // No changes — age 1 < threshold 2
    expect(result).toBe(messages);
  });
});
