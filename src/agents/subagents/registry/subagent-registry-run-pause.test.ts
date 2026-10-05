import { describe, expect, it } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { resolveYieldedRunContinuation } from "./subagent-registry-run-pause.js";

const NOW = Date.parse("2026-10-03T08:00:00Z");
const yielded = (overrides: Parameters<typeof createSubagentRunRecord>[0]) =>
  createSubagentRunRecord({
    pauseReason: "sessions_yield",
    startedAt: NOW - 60_000,
    endedAt: NOW - 30_000,
    ...overrides,
  });

describe("resolveYieldedRunContinuation", () => {
  it("never lets a continuation reach a collector without a recorded result", () => {
    expect(resolveYieldedRunContinuation(yielded({ runId: "c", collect: true }))).toEqual({
      state: "unreachable",
      error: expect.stringContaining("no recorded collectorCompletion"),
    });
  });

  it.each([
    {
      label: "a collector that already has a frozen result",
      overrides: { collect: true, collectorCompletion: { status: "done" as const } },
    },
    {
      label: "an orchestrator waiting on descendants",
      overrides: { expectsCompletionMessage: true, wakeOnDescendantSettle: true },
    },
    {
      label: "a leaf waiting for a message",
      overrides: { expectsCompletionMessage: true },
    },
  ])("keeps $label continuable", ({ overrides }) => {
    expect(resolveYieldedRunContinuation(yielded({ runId: "o", ...overrides }))).toEqual({
      state: "continuable",
    });
  });
});
