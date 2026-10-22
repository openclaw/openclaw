import { expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { resolveDeferredCleanupDecision } from "./subagent-registry-cleanup.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

type EntryOverrides = Omit<Partial<SubagentRunRecord>, "execution"> & { endedAt?: number };
const now = 2_000;
function decide({ endedAt = 1_000, ...overrides }: EntryOverrides = {}, activeDescendantRuns = 0) {
  return resolveDeferredCleanupDecision({
    entry: createSubagentRunRecord({
      runId: "run-1",
      endedAt,
      expectsCompletionMessage: true,
      ...overrides,
    }),
    now,
    activeDescendantRuns,
    announceExpiryMs: 5 * 60_000,
    announceCompletionHardExpiryMs: 30 * 60_000,
    deferDescendantDelayMs: 1_000,
    resolveAnnounceRetryDelayMs: (retryCount) => retryCount * 1_000,
  });
}

it("defers completion-message cleanup while descendants are pending", () => {
  expect(decide({}, 2)).toEqual({ kind: "defer-descendants", delayMs: 1_000 });
});

it("hard-expires completion cleanup when descendants never settle", () => {
  expect(decide({ endedAt: now - 30 * 60_000 }, 1)).toEqual({ kind: "give-up", reason: "expiry" });
});

it("honors a redriven completion at its delivery deadline", () => {
  const decision = decide({
    endedAt: now - 60 * 60_000,
    delivery: { status: "pending", windowStartedAt: now - 1_000, deadlineAt: now },
  });
  expect(decision.kind).toBe("give-up");
});

it.each([true, false])("backs off settled cleanup (completion required=%s)", (required) => {
  expect(
    decide({
      expectsCompletionMessage: required,
      delivery: { status: required ? "pending" : "not_required", attemptCount: 1 },
    }),
  ).toEqual({ kind: "retry", retryCount: 2, resumeDelayMs: 2_000 });
});
