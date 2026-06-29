// Tool-result char estimator tests cover malformed transcript blocks and cached
// character estimates used by context pressure guards.
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { convertToLlm } from "../../../packages/agent-core/src/harness/messages.js";
import {
  createMessageCharEstimateCache,
  estimateMessageCharsCached,
  getToolResultText,
} from "./tool-result-char-estimator.js";

function providerRenderedTextChars(message: AgentMessage): number {
  const [llm] = convertToLlm([message]);
  const content = (llm as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") {
    return content.length;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce((sum, block) => {
    if (
      block &&
      typeof block === "object" &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
    ) {
      return sum + (block as { text: string }).text.length;
    }
    return sum;
  }, 0);
}

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

  it("estimates bashExecution from the provider-rendered context text", () => {
    const msg = {
      role: "bashExecution",
      command: "npm run build",
      output: "build log line\n".repeat(100),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);

    expect(chars).toBe(providerRenderedTextChars(msg));
    expect(chars).toBeGreaterThan(256);
  });

  it("drops bashExecution messages excluded from model context", () => {
    const msg = {
      role: "bashExecution",
      command: "npm run build",
      output: "build log line\n".repeat(100),
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
      excludeFromContext: true,
    } as unknown as AgentMessage;

    const cache = createMessageCharEstimateCache();
    expect(estimateMessageCharsCached(msg, cache)).toBe(0);
  });

  it.each([
    [
      "compactionSummary",
      {
        role: "compactionSummary",
        summary: "recap ".repeat(100),
        tokensBefore: 12,
        timestamp: Date.now(),
      },
    ],
    [
      "branchSummary",
      {
        role: "branchSummary",
        summary: "branch recap ".repeat(100),
        fromId: "branch-1",
        timestamp: Date.now(),
      },
    ],
    [
      "custom",
      {
        role: "custom",
        customType: "notice",
        content: "custom context ".repeat(100),
        display: true,
        timestamp: Date.now(),
      },
    ],
  ])("estimates %s from the provider-rendered context text", (_role, message) => {
    const msg = message as unknown as AgentMessage;
    const cache = createMessageCharEstimateCache();
    const chars = estimateMessageCharsCached(msg, cache);

    expect(chars).toBe(providerRenderedTextChars(msg));
    expect(chars).toBeGreaterThan(256);
  });
});
