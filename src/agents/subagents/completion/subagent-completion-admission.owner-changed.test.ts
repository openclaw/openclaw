import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../test-utils/openclaw-test-state.js";
import type { SubagentAnnounceDeliveryResult } from "../announce/subagent-announce-dispatch.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { readSubagentRun } from "../registry/subagent-registry.store.sqlite.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import * as completionStore from "./subagent-completion-admission.store.js";
import {
  admitCompletionFixtureDatabase,
  advanceRequesterWakeTime,
  armRequesterWake,
  failedRecords,
  records,
  requesterWakeDriver,
  seedSubagentCompletionDelivery,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";

vi.mock("../registry/subagent-registry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../registry/subagent-registry.js")>()),
  resumeSubagentRun: vi.fn(),
}));

// Which outcomes may report a stuck wake (openclaw#154252). The real lifecycle controller over the real
// completion store; only the requester transport is substituted, so each attempt completes the
// wake with the outcome under test.
const RUN_ID = "completion-run";
const SIBLING_ID = "completion-sibling";
// Longer than the 120s backoff ceiling, so every tick admits exactly one retry.
const TICK_MS = 130_000;
const REPORT_AFTER = 5;
const REPORT_WARN = "requester settle wake keeps failing on an owner change; retries continue";

type Input = ReturnType<typeof records>;

const undelivered = (): SubagentAnnounceDeliveryResult => ({
  delivered: false,
  path: "none",
  error: "requester session unavailable",
});

describe("requester settle wake owner-changed report outcomes (#154252)", () => {
  let database: OpenClawStateDatabase;
  let testState: OpenClawTestState;

  beforeAll(async () => {
    testState = await createOpenClawTestState({ scenario: "minimal", applyEnv: true });
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });

  afterAll(async () => {
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    await testState.cleanup();
  });

  beforeEach(() => {
    database.db.exec("DELETE FROM subagent_runs");
    database.db.exec("DELETE FROM delivery_queue_entries");
    subagentRuns.clear();
    vi.useFakeTimers({ toNotFake: ["hrtime", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const persisted = (runId = RUN_ID) => readSubagentRun(database, runId) ?? undefined;
  const rewritePersisted = (mutate: (row: SubagentRunRecord) => void, runId = RUN_ID) => {
    const row = structuredClone(persisted(runId)!);
    mutate(row);
    seedSubagentCompletionDelivery({ subagent: row, databaseOptions: { database } });
  };
  const settleCalls = () => {
    const calls = { count: 0 };
    const mutate = completionStore.mutateRequesterCompletionBatch;
    vi.spyOn(completionStore, "mutateRequesterCompletionBatch").mockImplementation((params) => {
      calls.count += 1;
      return mutate(params);
    });
    return calls;
  };
  /** A frozen cohort member that exists only in SQLite: every settle fails owner-changed. */
  const strandCohortMember = (input: Input) => {
    seedSubagentCompletionOwner({ subagent: input.subagent, databaseOptions: { database } });
    const ids = [RUN_ID, SIBLING_ID];
    input.subagent.requesterSettleWake!.batchRunIds = ids;
    const sibling = armRequesterWake(records(), ids);
    Object.assign(sibling.subagent, {
      runId: SIBLING_ID,
      taskRunId: "sibling-task",
      childSessionKey: "agent:main:subagent:sibling",
    });
    seedSubagentCompletionDelivery({ subagent: input.subagent, databaseOptions: { database } });
    seedSubagentCompletionDelivery({ subagent: sibling.subagent, databaseOptions: { database } });
  };
  const startWake = async (input: Input, outcome: SubagentAnnounceDeliveryResult | undefined) => {
    const driver = requesterWakeDriver([input]);
    driver.wake.mockImplementation(async (params) => {
      await params.completeBatch([input.subagent], 1, outcome);
      return true;
    });
    await driver.run();
    return driver;
  };
  const tick = async (count: number) => {
    for (let i = 0; i < count; i += 1) {
      await advanceRequesterWakeTime(TICK_MS);
    }
  };
  const reportWarns = (driver: { warn: ReturnType<typeof vi.fn> }) =>
    driver.warn.mock.calls.filter(([message]) => message === REPORT_WARN);

  it("control: an undelivered outcome on a stranded cohort is reported once and keeps retrying", async () => {
    const input = failedRecords("failed", { status: "error", error: "child failed" });
    strandCohortMember(input);
    const calls = settleCalls();
    const driver = await startWake(input, undelivered());
    try {
      // The first attempt runs at start; each tick admits one more.
      await tick(REPORT_AFTER - 1);
      expect(reportWarns(driver)).toHaveLength(1);
      expect(calls.count).toBe(REPORT_AFTER);
      await tick(REPORT_AFTER);
      expect(calls.count).toBe(REPORT_AFTER * 2);
      expect(reportWarns(driver)).toHaveLength(1);
      expect(persisted()?.requesterSettleWake).toBeDefined();
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("never reports a sessions_yield cohort, however long owner-changed repeats", async () => {
    const input = failedRecords("failed", { status: "error", error: "child failed" });
    input.subagent.pauseReason = "sessions_yield";
    strandCohortMember(input);
    const calls = settleCalls();
    const driver = await startWake(input, undelivered());
    try {
      await tick(REPORT_AFTER * 2);
      expect(calls.count).toBeGreaterThan(REPORT_AFTER * 2 - 1);
      expect(reportWarns(driver)).toEqual([]);
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("never reports a delivered outcome, and settles it once the rows agree", async () => {
    const input = failedRecords("failed", { status: "error", error: "child failed" });
    strandCohortMember(input);
    const calls = settleCalls();
    const driver = await startWake(input, { delivered: true, path: "direct" });
    try {
      await tick(REPORT_AFTER * 2);
      expect(calls.count).toBeGreaterThan(REPORT_AFTER * 2 - 1);
      expect(reportWarns(driver)).toEqual([]);
      expect(persisted()?.requesterSettleWake).toBeDefined();

      rewritePersisted((row) => (row.requesterSettleWake = undefined), SIBLING_ID);
      await tick(1);
      expect(persisted()?.requesterSettleWake).toBeUndefined();
      expect(persisted()?.delivery?.status).toBe("delivered");
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it("settles a wake with no outcome in one attempt on the stranded cohort, so it is never reported", async () => {
    const input = failedRecords("failed", { status: "error", error: "child failed" });
    strandCohortMember(input);
    const calls = settleCalls();
    const driver = await startWake(input, undefined);
    try {
      await tick(REPORT_AFTER);
      expect(calls.count).toBe(1);
      expect(persisted()?.requesterSettleWake).toBeUndefined();
      expect(reportWarns(driver)).toEqual([]);
    } finally {
      driver.controller.clearScheduledResumeTimers();
    }
  });
});
