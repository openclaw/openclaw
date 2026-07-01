// Tool-result char estimator tests cover malformed transcript blocks and cached
// character estimates used by context pressure guards.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "../runtime/index.js";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
} from "./tool-result-char-estimator.js";

/**
 * Regression tests for malformed tool result content blocks.
 * See https://github.com/openclaw/openclaw/issues/34979
 *
 * A plugin tool handler returning undefined produces {type: "text"} (no text
 * property) in the session JSONL. Without guards, this crashes the char
 * estimator with: TypeError: Cannot read properties of undefined (reading 'length')
 */
describe("tool-result-char-estimator", () => {
  it("uses the unknown-block fallback for malformed text blocks", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }],
      isError: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(malformed, cache);
    expect(chars).toBe(30);
  });

  it("estimates text content when toolResult content includes null entries", () => {
    const malformed = {
      role: "toolResult",
      toolName: "read",
      content: [null, { type: "text", text: "ok" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(malformed, cache);
    expect(chars).toBe(12);
  });

  it("getToolResultText skips malformed text blocks", () => {
    const malformed = {
      role: "toolResult",
      toolName: "sentinel_control",
      content: [{ type: "text" }, { type: "text", text: "valid" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    expect(getToolResultText(malformed)).toBe("valid");
  });

  it("estimates well-formed toolResult correctly", () => {
    const msg = {
      role: "toolResult",
      toolName: "read",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBe(22);
  });

  it("counts bashExecution output instead of the flat 256 fallback", () => {
    // The render wraps command + output with markers via bashExecutionToText.
    // Use a large output so the rendered length clearly exceeds the legacy 256
    // flat fallback and proves the estimator reads the actual render.
    const output = "x".repeat(500);
    const msg = {
      role: "bashExecution",
      command: "printf hello",
      output,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    // bashExecutionToText joins command + output, so the rendered length is
    // at least the output length and exceeds the 256 fallback.
    expect(chars).toBeGreaterThan(output.length);
    expect(chars).toBeGreaterThan(256);
  });

  it("returns 0 for bashExecution records flagged excludeFromContext", () => {
    const msg = {
      role: "bashExecution",
      command: "printf hello",
      output: "hello world",
      excludeFromContext: true,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(0);
  });

  it("counts compactionSummary text with the convertToLlm wrapper", () => {
    const summary = "prior conversation distilled into a paragraph";
    const msg = {
      role: "compactionSummary",
      summary,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(
      (COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX).length,
    );
  });

  it("counts branchSummary text with the convertToLlm wrapper", () => {
    const summary = "branch recap text that should be counted";
    const msg = {
      role: "branchSummary",
      summary,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(
      (BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX).length,
    );
  });

  it("counts custom message content as the rendered length", () => {
    const content = "free-form custom message body";
    const msg = {
      role: "custom",
      content,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(content.length);
  });
});
