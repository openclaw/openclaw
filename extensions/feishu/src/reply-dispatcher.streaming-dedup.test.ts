import { describe, expect, it } from "vitest";
import { mergeStreamingText } from "./streaming-card.js";

/**
 * Unit tests for the block-boundary detection logic used in
 * `queueStreamingUpdate` (snapshot mode) inside reply-dispatcher.ts.
 *
 * The actual detection lives inline in a closure, so we replicate the
 * algorithm here to verify correctness in isolation.
 */

/** Minimal reproduction of the snapshot-mode block-boundary detection. */
function simulateSnapshotUpdates(snapshots: string[]): string {
  let streamText = "";
  let blockBaseText = "";
  let lastCumulativeLen = 0;

  for (const nextText of snapshots) {
    if (!nextText) {
      continue;
    }
    const currentBlock = blockBaseText ? streamText.slice(blockBaseText.length) : streamText;
    const isNewBlock =
      lastCumulativeLen >= 20 &&
      nextText.length < lastCumulativeLen * 0.5 &&
      !currentBlock.includes(nextText);
    if (isNewBlock) {
      blockBaseText = streamText;
      streamText = blockBaseText + nextText;
    } else {
      const merged = mergeStreamingText(currentBlock, nextText);
      streamText = blockBaseText + merged;
    }
    lastCumulativeLen = nextText.length;
  }
  return streamText;
}

describe("snapshot block-boundary detection", () => {
  it("merges cumulative snapshots within a single block", () => {
    // Normal cumulative growth — each snapshot extends the previous.
    const result = simulateSnapshotUpdates(["Hello", "Hello world", "Hello world, how are you?"]);
    expect(result).toBe("Hello world, how are you?");
  });

  it("detects a new block after a tool call resets cumulative text", () => {
    // Block 1 builds up to ~50 chars, then block 2 starts from scratch.
    const block1 = [
      "I'll search for that information.",
      "I'll search for that information. Let me check the docs.",
    ];
    const block2 = [
      "Based on",
      "Based on the search results,",
      "Based on the search results, the answer is 42.",
    ];
    const result = simulateSnapshotUpdates([...block1, ...block2]);
    expect(result).toBe(
      "I'll search for that information. Let me check the docs." +
        "Based on the search results, the answer is 42.",
    );
  });

  it("handles three consecutive blocks from multiple tool calls", () => {
    const block1 = ["Let me look that up for you.", "Let me look that up for you. Searching..."];
    const block2 = ["Found some results.", "Found some results. Let me analyze them."];
    const block3 = ["The analysis shows", "The analysis shows that performance improved by 30%."];
    const result = simulateSnapshotUpdates([...block1, ...block2, ...block3]);
    expect(result).toBe(
      "Let me look that up for you. Searching..." +
        "Found some results. Let me analyze them." +
        "The analysis shows that performance improved by 30%.",
    );
  });

  it("does not false-trigger on short first blocks (< 20 chars)", () => {
    // First block is short, second block starts — should NOT trigger
    // block detection because lastCumulativeLen < 20.
    const result = simulateSnapshotUpdates(["OK", "OK.", "Sure"]);
    // "OK." is only 3 chars, so "Sure" should be appended via mergeStreamingText
    // (no false block boundary since lastCumulativeLen=3 < 20).
    expect(result).toBe("OK.Sure");
  });

  it("does not false-trigger when snapshot is a substring of current block", () => {
    // The incoming text is short but IS contained in the current block.
    const base = "The quick brown fox jumps over the lazy dog.";
    const result = simulateSnapshotUpdates([
      base,
      // This is shorter but is a substring — should NOT trigger new block.
      "fox jumps",
    ]);
    // mergeStreamingText should keep the longer text since it includes the shorter.
    expect(result).toBe(base);
  });

  it("preserves exact text without duplication in real-world scenario", () => {
    // Simulates: agent writes config, calls tool, writes more config.
    const configBlock = Array.from({ length: 5 }, (_, i) => {
      const lines = [];
      for (let j = 0; j <= i; j++) {
        lines.push(`line ${j + 1}: value${j + 1}`);
      }
      return lines.join("\n");
    });
    // After tool call, new block starts:
    const analysisBlock = [
      "Here's my analysis:",
      "Here's my analysis:\n- Point A is correct",
      "Here's my analysis:\n- Point A is correct\n- Point B needs revision",
    ];
    const result = simulateSnapshotUpdates([...configBlock, ...analysisBlock]);
    expect(result).toBe(
      "line 1: value1\nline 2: value2\nline 3: value3\nline 4: value4\nline 5: value5" +
        "Here's my analysis:\n- Point A is correct\n- Point B needs revision",
    );
  });
});
