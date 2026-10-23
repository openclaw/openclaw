import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import type { ToolResultMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  estimateToolResultReductionPotential,
  truncateOversizedToolResultsInMessages,
} from "./tool-result-truncation.js";

function makeToolResult(text: string, toolCallId: string, timestamp: number): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId,
    toolName: "read",
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
  };
}

function getFirstToolResultText(message: AgentMessage): string {
  if (message.role !== "toolResult") {
    return "";
  }
  const firstBlock = message.content[0];
  return firstBlock && "text" in firstBlock ? firstBlock.text : "";
}

describe("estimateToolResultReductionPotential", () => {
  type Estimate = ReturnType<typeof estimateToolResultReductionPotential>;
  it.each([
    {
      kind: "small",
      texts: ["small result"],
      contextWindowTokens: 128_000,
      check: (estimate: Estimate) => {
        expect(estimate.maxReducibleChars).toBe(0);
      },
    },
    {
      kind: "aggregate",
      texts: Array<string>(6).fill("alpha beta gamma delta epsilon ".repeat(400)),
      contextWindowTokens: 20_000,
      check: (estimate: Estimate) => {
        expect(estimate.oversizedCount).toBe(0);
        expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
        expect(estimate.maxReducibleChars).toBe(estimate.aggregateReducibleChars);
      },
    },
    {
      kind: "mixed",
      texts: [
        "x".repeat(500_000),
        ...Array<string>(2).fill("alpha beta gamma delta epsilon ".repeat(800)),
      ],
      contextWindowTokens: 128_000,
      aggregateMaxCharsOverride: 50_000,
      check: (estimate: Estimate) => {
        expect(estimate.oversizedCount).toBeGreaterThan(0);
        expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
        expect(estimate.maxReducibleChars).toBeGreaterThan(estimate.aggregateReducibleChars);
      },
    },
    {
      kind: "explicit cap",
      texts: Array<string>(3).fill("alpha beta gamma delta epsilon ".repeat(600)),
      contextWindowTokens: 128_000,
      maxCharsOverride: 120,
      aggregateMaxCharsOverride: 120,
      check: (estimate: Estimate, projected: AgentMessage[]) => {
        expect(estimate.oversizedCount).toBe(3);
        expect(estimate.aggregateReducibleChars).toBeGreaterThan(0);
        const sizes = projected.map((message) =>
          estimateStringChars(getFirstToolResultText(message)),
        );
        expect(sizes.every((size) => size <= 120)).toBe(true);
        expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(120);
      },
    },
  ])("estimates $kind recovery savings", ({ texts, check, ...budgets }) => {
    const messages = texts.map((text, index) => makeToolResult(text, `call_${index}`, index + 1));
    const estimate = estimateToolResultReductionPotential({ ...budgets, messages });
    const projected = truncateOversizedToolResultsInMessages(
      messages,
      budgets.contextWindowTokens,
      "maxCharsOverride" in budgets ? budgets.maxCharsOverride : undefined,
      "aggregateMaxCharsOverride" in budgets ? budgets.aggregateMaxCharsOverride : undefined,
    );
    const originalChars = texts.reduce((sum, text) => sum + estimateStringChars(text), 0);
    const projectedChars = projected.messages.reduce(
      (sum, message) => sum + estimateStringChars(getFirstToolResultText(message)),
      0,
    );
    expect(estimate.maxReducibleChars).toBe(originalChars - projectedChars);
    check(estimate, projected.messages);
  });
});
