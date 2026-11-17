import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { SUBAGENT_ENDED_REASON_ERROR } from "./subagent-lifecycle-events.js";
import { subagentRegistryLog } from "./subagent-registry-lifecycle-log.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunPausedAfterYield } from "./subagent-registry-run-pause.js";
import {
  settleRestartInterruptedSubagentRun,
  SUBAGENT_RESTART_INTERRUPTED_ERROR,
} from "./subagent-registry-sweep-settle.js";
import { resetSubagentRegistryForTests } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const PROCESS_STARTED_AT = 1_800_000_000_000;
const NOW = PROCESS_STARTED_AT + 60_000;

function restoredRunningRow(overrides: Partial<SubagentRunRecord> = {}) {
  const entry = createSubagentRunRecord({
    runId: "restart-interrupted-run",
    requesterOrigin: { channel: "telegram", to: "chat:requester", accountId: "primary" },
    createdAt: PROCESS_STARTED_AT - 10 * 60_000,
    startedAt: PROCESS_STARTED_AT - 10 * 60_000,
    expectsCompletionMessage: true,
    ...overrides,
  });
  subagentRuns.set(entry.runId, entry);
  return entry;
}

function settle(entry: SubagentRunRecord) {
  const complete = vi.fn<Parameters<typeof settleRestartInterruptedSubagentRun>[0]["complete"]>(
    async () => {},
  );
  return {
    complete,
    settled: settleRestartInterruptedSubagentRun({
      runId: entry.runId,
      entry,
      complete,
      now: NOW,
      processStartedAt: PROCESS_STARTED_AT,
    }),
  };
}

beforeEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
});

afterEach(async () => {
  await resetSubagentRegistryForTests({ persist: false });
  vi.restoreAllMocks();
});

it("fails a running child restored from an earlier Gateway so its requester wakes", async () => {
  using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const entry = restoredRunningRow();
  // Restore retires completion authority for rows no live Gateway context owns.
  subagentRuns.retireCompletionAuthority(entry);

  const { complete, settled } = settle(entry);

  expect(await settled).toBe(true);
  expect(warning).toHaveBeenCalledWith("Settling subagent interrupted by Gateway restart", {
    runId: entry.runId,
    requesterSessionKey: entry.requesterSessionKey,
    createdAt: entry.createdAt,
  });
  expect(complete).toHaveBeenCalledWith(
    {
      runId: entry.runId,
      expectedEntry: entry,
      recoveryCurrent: undefined,
      endedAt: NOW,
      outcome: { status: "error", error: SUBAGENT_RESTART_INTERRUPTED_ERROR },
      reason: SUBAGENT_ENDED_REASON_ERROR,
      sendFarewell: true,
      accountId: "primary",
      triggerCleanup: true,
    },
    "sweeper-restart-interrupted",
  );
});

it.each([
  ["a row this process still owns", (_entry: SubagentRunRecord) => {}],
  [
    "a row this process created",
    (entry: SubagentRunRecord) => {
      entry.createdAt = PROCESS_STARTED_AT + 1;
      subagentRuns.retireCompletionAuthority(entry);
    },
  ],
  [
    "an ended row",
    (entry: SubagentRunRecord) => {
      entry.execution = {
        status: "terminal",
        startedAt: entry.execution.startedAt,
        endedAt: NOW - 1,
        outcome: { status: "ok" },
      };
      subagentRuns.retireCompletionAuthority(entry);
    },
  ],
  [
    "a yielded row",
    (entry: SubagentRunRecord) => {
      markSubagentRunPausedAfterYield({ entry });
      subagentRuns.retireCompletionAuthority(entry);
    },
  ],
] as const)("leaves %s to its existing owner", async (_name, prepare) => {
  using warning = vi.spyOn(subagentRegistryLog, "warn").mockImplementation(() => {});
  const entry = restoredRunningRow();
  prepare(entry);

  const { complete, settled } = settle(entry);

  expect(await settled).toBe(false);
  expect(complete).not.toHaveBeenCalled();
  expect(warning).not.toHaveBeenCalled();
});
