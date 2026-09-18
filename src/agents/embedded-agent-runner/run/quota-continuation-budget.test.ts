import { afterEach, describe, expect, it, vi } from "vitest";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { createQuotaContinuationBudget } from "./quota-continuation-budget.js";
import { isRunRetryBudgetExhausted } from "./retry-budget.js";

afterEach(() => vi.restoreAllMocks());
describe("logical quota continuation allowance", () => {
  it("charges earlier candidates, setup and settlement without renewing the original limit", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = createQuotaContinuationBudget({ runId: "budget", sessionId: "session" });
    budget.initialize(1000);
    now = 990;
    expect(budget.remainingMs(1000)).toBe(10);
    budget.initialize(1000);
    now = 1001;
    expect(budget.remainingMs(1000)).toBe(0);
    budget.dispose();
  });
  it("preserves the existing approval-pause accounting", () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const budget = createQuotaContinuationBudget({
      runId: "budget-approval",
      sessionId: "session",
    });
    budget.initialize(1000);
    now = 900;
    emitAgentEvent({
      runId: "budget-approval",
      sessionId: "session",
      stream: "lifecycle",
      data: { phase: "waiting-approval", approvalId: "permission" },
    });
    expect(budget.remainingMs()).toBe(0);
    now = 5000;
    emitAgentEvent({
      runId: "budget-approval",
      sessionId: "session",
      stream: "lifecycle",
      data: { phase: "approval-resolved", approvalId: "permission" },
    });
    expect(budget.remainingMs()).toBe(100);
    now = 5090;
    expect(budget.remainingMs()).toBe(10);
    budget.dispose();
  });
  it("carries consumed retry accounting instead of creating another complete allowance", () => {
    const budget = createQuotaContinuationBudget({});
    budget.observeRetries({ maxAttempts: 5, attemptsCounted: 2, attemptsDispatched: 2 });
    budget.observeRetries({ maxAttempts: 5, attemptsCounted: 3, attemptsDispatched: 3 });
    const resumed = budget.continueRetries(10);
    expect(resumed).toEqual({ maxAttempts: 5, attemptsCounted: 5, attemptsDispatched: 5 });
    expect(isRunRetryBudgetExhausted(resumed)).toBe(true);
    expect(budget.continueRetries(100)).toBe(resumed);
    budget.dispose();
  });
});
