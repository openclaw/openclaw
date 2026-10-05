import { describe, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { settleUnreachableYieldedSubagentRun } from "./subagent-registry-sweep-settle.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const PAUSED_AT = Date.parse("2026-10-03T08:00:00Z");

type RunOverrides = NonNullable<Parameters<typeof createSubagentRunRecord>[0]>;

const yielded = (overrides: Partial<RunOverrides> = {}) =>
  createSubagentRunRecord({
    runId: "parked-run",
    pauseReason: "sessions_yield",
    createdAt: PAUSED_AT - 60_000,
    startedAt: PAUSED_AT - 30_000,
    endedAt: PAUSED_AT,
    ...overrides,
  });
const collector = (overrides: Partial<RunOverrides> = {}) =>
  yielded({ collect: true, expectsCompletionMessage: false, ...overrides });

const settle = async (entry: SubagentRunRecord) => {
  const complete = vi.fn(async () => undefined);
  const settled = await settleUnreachableYieldedSubagentRun({
    runId: entry.runId,
    entry,
    complete,
  });
  return { settled, complete };
};

describe("settleUnreachableYieldedSubagentRun", () => {
  it("asks the completion owner to settle a collector without a result at its yield time", async () => {
    const entry = collector();
    const { settled, complete } = await settle(entry);
    expect(settled).toBe(true);
    expect(complete).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "parked-run",
        expectedEntry: entry,
        endedAt: PAUSED_AT,
        settleYielded: true,
        outcome: { status: "error", error: expect.stringContaining("Collector yielded") },
      }),
      "sweeper-unreachable-yield",
    );
  });

  it.each([
    {
      label: "a leaf waiting on a message, however long ago it paused",
      entry: () =>
        yielded({ expectsCompletionMessage: true, endedAt: PAUSED_AT - 400 * 86_400_000 }),
    },
    {
      label: "an orchestrator waiting on descendants",
      entry: () => yielded({ expectsCompletionMessage: true, wakeOnDescendantSettle: true }),
    },
    {
      label: "a collector with a frozen result",
      entry: () => collector({ collectorCompletion: { status: "done" } }),
    },
  ])("never settles $label", async ({ entry }) => {
    const { settled, complete } = await settle(entry());
    expect(settled).toBe(false);
    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "kill intent",
      overrides: { killIntent: { requestedAt: PAUSED_AT, reason: "operator" } },
    },
    { label: "kill reconciliation", overrides: { killReconciliation: { killedAt: PAUSED_AT } } },
    { label: "a killed announce suppression", overrides: { suppressAnnounceReason: "killed" } },
    { label: "a killed ended reason", overrides: { endedReason: "subagent-killed" } },
    { label: "a resumed run", overrides: { pauseReason: undefined } },
  ] as const)(
    "never settles a collector excluded as not yielded: $label",
    async ({ overrides }) => {
      const { settled, complete } = await settle(collector(overrides));
      expect(settled).toBe(false);
      expect(complete).not.toHaveBeenCalled();
    },
  );
});
