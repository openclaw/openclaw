// Tool-result char estimator tests cover malformed transcript blocks and cached
// character estimates used by context pressure guards.
import type { AgentMessage, BashExecutionMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import {
  bashExecutionToText,
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

  it("estimates bashExecution from rendered text, not flat 256", () => {
    const msg = {
      role: "bashExecution",
      command: "ls -la",
      output: "total 42\ndrwxr-xr-x  5 user  staff   160 Jun 30 12:00 .",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    // Rendered text matches bashExecutionToText output exactly; no longer flat 256.
    const rendered = bashExecutionToText(msg as unknown as BashExecutionMessage);
    expect(chars).toBe(rendered.length);
    expect(chars).not.toBe(256);
  });

  it("returns 0 for bashExecution excluded from context", () => {
    const msg = {
      role: "bashExecution",
      command: "secret-command",
      output: "classified",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      excludeFromContext: true,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(0);
  });

  it("estimates branchSummary from rendered prefix + summary + suffix", () => {
    const summary = "This branch explored an alternative approach to authentication.";
    const msg = {
      role: "branchSummary",
      summary,
      fromId: "entry-123",
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBeGreaterThan(summary.length);
    expect(chars).toBe(
      BRANCH_SUMMARY_PREFIX.length + summary.length + BRANCH_SUMMARY_SUFFIX.length,
    );
  });

  it("estimates compactionSummary from rendered prefix + summary + suffix", () => {
    const summary = "Compacted conversation about database schema design.";
    const msg = {
      role: "compactionSummary",
      summary,
      tokensBefore: 5000,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);
    expect(chars).toBeGreaterThan(summary.length);
    expect(chars).toBe(
      COMPACTION_SUMMARY_PREFIX.length + summary.length + COMPACTION_SUMMARY_SUFFIX.length,
    );
  });

  it("estimates custom message from content string length", () => {
    const msg = {
      role: "custom",
      customType: "test-marker",
      content: "custom content string",
      display: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(21);
  });
});
