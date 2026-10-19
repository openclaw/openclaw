import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { isDeliverySuspended } from "../registry/subagent-delivery-state.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import { bindSubagentRunRuntimeKey } from "../registry/subagent-run-generation.js";
import { blockSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  currentCompletionRun,
  armRequesterWake,
  reopenCompletionFixtureOwners,
  records,
  requesterWakeDriver,
  admitCompletionFixtureDatabase,
  readCompletionSystemEvents,
  seedSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("requester receipts after completion expiry", () => {
  let database: OpenClawStateDatabase;

  beforeEach(async () => {
    vi.stubEnv(
      "OPENCLAW_STATE_DIR",
      tempDirs.make("openclaw-expired-receipt-", resolvePreferredOpenClawTmpDir()),
    );
    database = openOpenClawStateDatabase();
    await admitCompletionFixtureDatabase();
  });

  afterEach(async () => {
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  async function suspend(
    options: {
      completionTarget?: "parent";
      reason?: "expiry" | "permanent_failure";
      resultText?: string | null;
    } = {},
  ) {
    const input = armRequesterWake(records());
    input.subagent.cleanupHandled = false;
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.completionTarget = options.completionTarget;
    input.subagent.completionRequesterSessionId = options.completionTarget
      ? "requester-session"
      : undefined;
    input.subagent.delivery = { status: "pending", generation: 1 };
    if (options.resultText !== undefined) {
      input.subagent.completion!.resultText = options.resultText;
    }
    seedSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
    subagentRuns.set(input.subagent.runId, input.subagent);
    expect(
      await blockSubagentCompletionDelivery({
        subagent: input.subagent,

        reason: "completion delivery expired",
        suspendedReason: options.reason ?? "expiry",
        databaseOptions: { database },
      }),
    ).toBe(true);
    input.subagent = currentCompletionRun(input);
    expect(isDeliverySuspended(input.subagent)).toBe(true);
    return input;
  }

  function settle(input: ReturnType<typeof records>, delivered: boolean) {
    return settleRequesterCompletionBatch({
      entries: [input.subagent],
      outcome: { delivered, path: "direct", error: delivered ? undefined : "requester failed" },
      assertCurrent: () => {},
      databaseOptions: { database },
    });
  }

  it("retains an admitted cleanup lock while publishing the requester receipt", async () => {
    const input = armRequesterWake(records());
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = { status: "pending", generation: 1 };
    seedSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
    subagentRuns.set(input.subagent.runId, input.subagent);

    await settle(input, true);

    expect(subagentRuns.get(input.subagent.runId)).not.toBe(input.subagent);
    expect(currentCompletionRun(input).cleanupHandled).toBe(true);
    expect(currentCompletionRun(input).cleanupCompletedAt).toBeUndefined();
    expect(currentCompletionRun(input).requesterSettleWake).toBeUndefined();
    expect(currentCompletionRun(input).delivery?.status).toBe("delivered");
    database = await reopenCompletionFixtureOwners();
    // Process-local custody cannot survive a restart without durable completion.
    expect(subagentRuns.get(input.subagent.runId)?.cleanupHandled).toBe(false);
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
  });

  it.each([
    { completionTarget: undefined, resultText: "canonical result" },
    { completionTarget: "parent", resultText: "canonical result" },
    { completionTarget: "parent", resultText: null },
  ] as const)(
    "records a successful requester wake after expiry (target=$completionTarget, result=$resultText)",
    async ({ completionTarget, resultText }) => {
      const input = await suspend({ completionTarget, resultText });
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        return true;
      });
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalled();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(isDeliverySuspended(currentCompletionRun(input))).toBe(false);
        database = await reopenCompletionFixtureOwners();
        const stored = subagentRuns.get(input.subagent.runId);
        expect(stored?.delivery?.status).toBe("delivered");
        expect(stored?.delivery?.suspendedAt).toBeUndefined();
        expect(stored?.delivery?.suspendedReason).toBeUndefined();
        expect(stored?.delivery?.lastError).toBeUndefined();
        expect(stored?.delivery?.payload).toBeUndefined();
        expect(stored?.requesterSettleWake).toBeUndefined();
        expect(stored?.completion?.resultText).toBe(resultText);
      } finally {
        driver.controller.clearRuntimeState();
      }
    },
  );

  it("does not recover permanent_failure from a successful receipt", async () => {
    const input = await suspend({ reason: "permanent_failure" });
    await settle(input, true);
    database = await reopenCompletionFixtureOwners();
    expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
  });

  it.each([undefined, "parent"] as const)(
    "fails the expired delivery when its requester wake ends undelivered (target=%s)",
    async (completionTarget) => {
      const input = await suspend({ completionTarget });
      const before = structuredClone(input.subagent);
      const notices = readCompletionSystemEvents(database);
      expect(notices).toHaveLength(1);
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch([input.subagent], 1, {
          delivered: false,
          path: "none",
          error: "requester turn failed",
        });
        return false;
      });
      try {
        await driver.run();
        database = await reopenCompletionFixtureOwners();
        const stored = subagentRuns.get(input.subagent.runId);
        expect(stored?.delivery).toMatchObject({
          status: "failed",
          disposition: "permanent_failure",
          lastError: "requester turn failed",
        });
        expect(stored?.delivery?.payload).toEqual(before.delivery?.payload);
        expect(stored?.completion).toEqual(before.completion);
        expect(stored?.suppressCompletionDelivery).toBe(true);
        expect(stored?.requesterSettleWake).toBeUndefined();
        expect(readCompletionSystemEvents(database)).toEqual(notices);
      } finally {
        driver.controller.clearRuntimeState();
      }
    },
  );

  it.each([
    "run",
    "execution",
    "host incarnation",
    "delivery generation",
    "registry write",
    "failed settlement write",
  ] as const)(
    "preserves the suspended delivery and wake when %s rejects the receipt",
    async (cut) => {
      const input = await suspend();
      const changed = structuredClone(input.subagent);
      if (cut === "run") {
        changed.taskRunId = "replacement-source-run";
      } else if (cut === "host incarnation") {
        bindSubagentRunRuntimeKey(changed, {});
        subagentRuns.set(changed.runId, changed);
      } else if (cut === "execution") {
        changed.endedReason = "subagent-killed";
        changed.execution.outcome = { status: "error", error: "cancelled by the requester" };
      } else if (cut === "delivery generation") {
        changed.delivery!.generation = 2;
      }
      const rejectWrite = cut === "registry write" || cut === "failed settlement write";
      if (cut !== "host incarnation" && !rejectWrite) {
        await mutateSubagentRuns(
          [changed.runId],
          () => ({ value: undefined, postimages: new Map([[changed.runId, changed]]) }),
          { runs: subagentRuns },
        );
      }
      if (rejectWrite) {
        database.db.exec(
          "CREATE TRIGGER reject_ack AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'ack write cut'); END",
        );
      }
      try {
        await expect(settle(input, cut !== "failed settlement write")).rejects.toThrow(
          rejectWrite ? "ack write cut" : /(owner|cohort) changed before mutation/,
        );
        expect(isDeliverySuspended(input.subagent)).toBe(true);
        expect(currentCompletionRun(input).requesterSettleWake).toBeDefined();
      } finally {
        if (rejectWrite) {
          database.db.exec("DROP TRIGGER reject_ack");
        }
      }
      database = await reopenCompletionFixtureOwners();
      expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
      if (cut === "delivery generation") {
        expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
          status: "suspended",
          generation: 2,
        });
      }
    },
  );
});
