import { describe, expect, it } from "vitest";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import {
  PREEMPTIVE_OVERFLOW_ERROR_TEXT,
  estimatePrePromptTokens,
  shouldPreemptivelyCompactBeforePrompt,
} from "./preemptive-compaction.js";

describe("preemptive-compaction", () => {
  const verboseHistory =
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu ".repeat(40);
  const verboseSystem =
    "system guidance with multiple distinct words to avoid tokenizer overcompression ".repeat(25);
  const verbosePrompt =
    "user request with distinct content asking for a detailed answer and more context ".repeat(25);

  it("exports a context-overflow-compatible precheck error text", () => {
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("Context overflow:");
    expect(PREEMPTIVE_OVERFLOW_ERROR_TEXT).toContain("(precheck)");
  });

  it("raises the estimate as prompt-side content grows", () => {
    const smaller = estimatePrePromptTokens({
      messages: [{ role: "assistant", content: verboseHistory }],
      systemPrompt: "sys",
      prompt: "hello",
    });
    const larger = estimatePrePromptTokens({
      messages: [{ role: "assistant", content: verboseHistory }],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });

    expect(larger).toBeGreaterThan(smaller);
  });

  it("requests preemptive compaction when the reserve-based prompt budget would be exceeded", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [{ role: "assistant", content: verboseHistory }],
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: 500,
      reserveTokens: 50,
    });

    expect(result.shouldCompact).toBe(true);
    expect(result.route).toBe("compact_only");
    expect(result.estimatedPromptTokens).toBeGreaterThan(result.promptBudgetBeforeReserve);
  });

  it("does not request preemptive compaction when the reserve-based prompt budget still fits", () => {
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages: [{ role: "assistant", content: "short history" }],
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: 10_000,
      reserveTokens: 1_000,
    });

    expect(result.shouldCompact).toBe(false);
    expect(result.route).toBe("fits");
    expect(result.estimatedPromptTokens).toBeLessThan(result.promptBudgetBeforeReserve);
  });

  it("routes to direct tool-result truncation when recent tool tails can clearly absorb the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(2200);
    const messages = [
      { role: "assistant", content: "short history" },
      {
        role: "toolResult",
        content: [
          { type: "text", text: medium },
          { type: "text", text: medium },
          { type: "text", text: medium },
          { type: "text", text: medium },
        ],
      } as never,
    ];
    const reserveTokens = 2_000;
    const contextTokenBudget = 26_000;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
    });
    const desiredOverflowTokens = 200;
    const adjustedContextTokenBudget =
      estimatedPromptTokens - desiredOverflowTokens + reserveTokens;
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: "sys",
      prompt: "hello",
      contextTokenBudget: Math.max(contextTokenBudget, adjustedContextTokenBudget),
      reserveTokens,
    });

    expect(result.route).toBe("truncate_tool_results_only");
    expect(result.shouldCompact).toBe(false);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });

  it("routes to compact then truncate when recent tool tails help but cannot fully cover the overflow", () => {
    const medium = "alpha beta gamma delta epsilon ".repeat(220);
    const longHistory = "old discussion with substantial retained context and decisions ".repeat(
      5000,
    );
    const messages = [
      { role: "assistant", content: longHistory },
      { role: "toolResult", content: [{ type: "text", text: medium }] } as never,
      { role: "toolResult", content: [{ type: "text", text: medium }] } as never,
      { role: "toolResult", content: [{ type: "text", text: medium }] } as never,
    ];
    const reserveTokens = 500;
    const baseContextTokenBudget = 3_500;
    const estimatedPromptTokens = estimatePrePromptTokens({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
    });
    const toolResultPotential = estimateToolResultReductionPotential({
      messages: messages as never,
      contextWindowTokens: baseContextTokenBudget,
    });
    const desiredOverflowTokens = Math.ceil((toolResultPotential.maxReducibleChars + 4_096) / 4);
    const result = shouldPreemptivelyCompactBeforePrompt({
      messages,
      systemPrompt: verboseSystem,
      prompt: verbosePrompt,
      contextTokenBudget: Math.max(
        baseContextTokenBudget,
        estimatedPromptTokens - desiredOverflowTokens + reserveTokens,
      ),
      reserveTokens,
    });

    expect(result.route).toBe("compact_then_truncate");
    expect(result.shouldCompact).toBe(true);
    expect(result.overflowTokens).toBeGreaterThan(0);
    expect(result.toolResultReducibleChars).toBeGreaterThan(0);
  });
});
