import { describe, expect, it } from "vitest";
import {
  BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION,
  buildBudgetExhaustedResult,
  shouldReturnBudgetExhausted,
} from "./budget-exhaustion.js";

describe("BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION", () => {
  it("is a non-empty string", () => {
    expect(typeof BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION).toBe("string");
    expect(BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION.length).toBeGreaterThan(0);
  });

  it("instructs the model not to make tool calls", () => {
    expect(BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION.toLowerCase()).toContain("tool");
  });

  it("asks for a summary", () => {
    expect(BUDGET_EXHAUSTION_SUMMARY_INSTRUCTION.toLowerCase()).toContain("summary");
  });
});

describe("shouldReturnBudgetExhausted", () => {
  const baseParams = {
    budgetExhausted: false,
    emptyAssistantReplyIsSilent: false,
    hasClientToolCalls: false,
    budgetSummaryAttempt: false,
    aborted: false,
    hasPromptError: false,
    timedOut: false,
    yieldDetected: false,
  };

  it("returns true when the budget gate blocked a tool call after visible assistant text", () => {
    expect(
      shouldReturnBudgetExhausted({
        ...baseParams,
        budgetExhausted: true,
      }),
    ).toBe(true);
  });

  it("does not treat a visible final answer as exhaustion without an explicit budget block", () => {
    expect(
      shouldReturnBudgetExhausted({
        ...baseParams,
      }),
    ).toBe(false);
  });

  it("does not treat exact budget depletion as exhaustion without an explicit budget block", () => {
    expect(shouldReturnBudgetExhausted(baseParams)).toBe(false);
  });
});

describe("buildBudgetExhaustedResult", () => {
  it("builds a result with budget_exhausted error kind", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      budgetUsed: 90,
      budgetMax: 90,
    });

    expect(result.meta.error?.kind).toBe("budget_exhausted");
    expect(result.meta.error?.fallbackSafe).toBe(false);
    expect(result.meta.livenessState).toBe("blocked");
    expect(result.meta.replayInvalid).toBe(true);
  });

  it("includes budget counts in the error message", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      budgetUsed: 45,
      budgetMax: 90,
    });

    expect(result.meta.error?.message).toContain("45");
    expect(result.meta.error?.message).toContain("90");
  });

  it("uses summaryText as the payload text when provided", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      budgetUsed: 90,
      budgetMax: 90,
      summaryText: "Here is what I accomplished...",
    });

    expect(result.payloads?.[0]?.text).toBe("Here is what I accomplished...");
    expect(result.payloads?.[0]?.isError).toBe(false);
  });

  it("uses a default error payload when summaryText is not provided", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      budgetUsed: 90,
      budgetMax: 90,
    });

    expect(result.payloads?.[0]?.text).toContain("90/90");
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("sets durationMs from params", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 12345,
      budgetUsed: 10,
      budgetMax: 10,
    });

    expect(result.meta.durationMs).toBe(12345);
  });

  it("passes through agentMeta when provided", () => {
    const agentMeta = {
      sessionId: "test-session",
      provider: "anthropic",
      model: "claude-sonnet",
    };
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      agentMeta,
      budgetUsed: 10,
      budgetMax: 10,
    });

    expect(result.meta.agentMeta).toBe(agentMeta);
  });

  it("passes through finalAssistantVisibleText", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      budgetUsed: 10,
      budgetMax: 10,
      finalAssistantVisibleText: "Last visible text",
    });

    expect(result.meta.finalAssistantVisibleText).toBe("Last visible text");
  });

  it("passes through delivery evidence", () => {
    const result = buildBudgetExhaustedResult({
      message: "Budget exceeded.",
      durationMs: 5000,
      budgetUsed: 10,
      budgetMax: 10,
      didSendViaMessagingTool: true,
      didDeliverSourceReplyViaMessageTool: true,
      didSendDeterministicApprovalPrompt: true,
      messagingToolSentTexts: ["already sent"],
      messagingToolSentMediaUrls: ["https://example.test/image.png"],
      messagingToolSentTargets: [{ tool: "message", provider: "telegram", to: "room" }],
      messagingToolSourceReplyPayloads: [{ text: "source reply" }],
      heartbeatToolResponse: { outcome: "progress", notify: false, summary: "still working" },
      successfulCronAdds: 2,
      acceptedSessionSpawns: [{ runId: "run-child", childSessionKey: "agent:child" }],
    });

    expect(result.didSendViaMessagingTool).toBe(true);
    expect(result.didDeliverSourceReplyViaMessageTool).toBe(true);
    expect(result.didSendDeterministicApprovalPrompt).toBe(true);
    expect(result.messagingToolSentTexts).toEqual(["already sent"]);
    expect(result.messagingToolSentMediaUrls).toEqual(["https://example.test/image.png"]);
    expect(result.messagingToolSentTargets).toEqual([
      { tool: "message", provider: "telegram", to: "room" },
    ]);
    expect(result.messagingToolSourceReplyPayloads).toEqual([{ text: "source reply" }]);
    expect(result.heartbeatToolResponse).toEqual({
      outcome: "progress",
      notify: false,
      summary: "still working",
    });
    expect(result.successfulCronAdds).toBe(2);
    expect(result.acceptedSessionSpawns).toEqual([
      { runId: "run-child", childSessionKey: "agent:child" },
    ]);
  });
});
