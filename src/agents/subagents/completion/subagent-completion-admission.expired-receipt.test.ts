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
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import {
  blockSubagentCompletionDelivery,
  settleRequesterCompletionBatch,
} from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
  admitCompletionFixtureDatabase,
  seedSubagentCompletionDelivery,
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
    expect(isDeliverySuspended(input.subagent)).toBe(true);
    return input;
  }

  function settle(input: ReturnType<typeof records>, delivered: boolean) {
    return settleRequesterCompletionBatch({
      entries: [{ subagent: input.subagent }],
      outcome: { delivered, path: "direct", error: delivered ? undefined : "requester failed" },
      isCurrent: () => true,
      databaseOptions: { database },
    });
  }

  async function reopen() {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
  }

  it("retains an admitted cleanup lock while publishing the requester receipt", async () => {
    const input = armRequesterWake(records());
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = { status: "pending", generation: 1 };
    seedSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
    subagentRuns.set(input.subagent.runId, input.subagent);

    await settle(input, true);

    expect(subagentRuns.get(input.subagent.runId)).toBe(input.subagent);
    expect(input.subagent.cleanupHandled).toBe(true);
    expect(input.subagent.cleanupCompletedAt).toBeUndefined();
    expect(input.subagent.requesterSettleWake).toBeUndefined();
    expect(input.subagent.delivery?.status).toBe("delivered");
    await reopen();
    // Process-local custody cannot survive a restart without durable completion.
    expect(subagentRuns.get(input.subagent.runId)?.cleanupHandled).toBe(false);
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
  });

  it.each([undefined, "parent"] as const)(
    "records a successful requester wake after expiry (target=%s)",
    async (completionTarget) => {
      const input = await suspend({ completionTarget });
      const driver = requesterWakeDriver([input]);
      driver.wake.mockImplementation(async (params) => {
        await params.completeBatch([input.subagent], 1, { delivered: true, path: "direct" });
        return true;
      });
      try {
        await driver.run();
        expect(driver.warn).not.toHaveBeenCalled();
        expect(driver.wake).toHaveBeenCalledOnce();
        expect(isDeliverySuspended(input.subagent)).toBe(false);
        await reopen();
        const stored = subagentRuns.get(input.subagent.runId);
        expect(stored?.delivery?.status).toBe("delivered");
        expect(stored?.delivery?.suspendedAt).toBeUndefined();
        expect(stored?.delivery?.suspendedReason).toBeUndefined();
        expect(stored?.delivery?.lastError).toBeUndefined();
        expect(stored?.delivery?.payload).toBeUndefined();
        expect(stored?.requesterSettleWake).toBeUndefined();
        expect(stored?.completion?.resultText).toBe("canonical result");
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );

  it("preserves a missing-deliverable verdict after its delivery is acknowledged", async () => {
    const input = await suspend({ completionTarget: "parent", resultText: null });
    await settle(input, true);
    await reopen();
    expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("delivered");
  });

  it.each([
    { reason: "expiry" as const, delivered: false },
    { reason: "permanent_failure" as const, delivered: true },
  ])(
    "does not recover $reason without an eligible successful receipt",
    async ({ reason, delivered }) => {
      const input = await suspend({ reason });
      await settle(input, delivered);
      await reopen();
      expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
    },
  );

  it("rejects an acknowledgment after the durable delivery generation changes", async () => {
    const input = await suspend();
    const changed = structuredClone(input.subagent);
    changed.delivery!.generation = 2;
    seedSubagentCompletionDelivery({
      subagent: changed,

      databaseOptions: { database },
    });
    await expect(settle(input, true)).rejects.toThrow("owner changed before settlement");
    await reopen();
    expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
      status: "suspended",
      generation: 2,
    });
    expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
  });

  it.each(["run", "execution"] as const)(
    "rejects a changed native %s owner",
    async (changedOwner) => {
      const input = await suspend();
      const changed = structuredClone(input.subagent);
      if (changedOwner === "run") {
        changed.taskRunId = "replacement-source-run";
      } else {
        changed.endedReason = "subagent-killed";
        changed.execution.outcome = { status: "error", error: "cancelled by the requester" };
      }
      seedSubagentCompletionDelivery({
        subagent: changed,
        databaseOptions: { database },
      });
      await expect(settle(input, true)).rejects.toThrow("owner changed before settlement");
      await reopen();
      expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
      expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
    },
  );

  it("rolls back delivery and wake changes together if the registry write fails", async () => {
    const input = await suspend();
    database.db.exec(
      "CREATE TRIGGER reject_ack AFTER UPDATE ON subagent_runs BEGIN SELECT RAISE(ABORT, 'ack write cut'); END",
    );
    try {
      await expect(settle(input, true)).rejects.toThrow("ack write cut");
      expect(isDeliverySuspended(input.subagent)).toBe(true);
      expect(input.subagent.requesterSettleWake).toBeDefined();
    } finally {
      database.db.exec("DROP TRIGGER reject_ack");
    }
    await reopen();
    expect(isDeliverySuspended(subagentRuns.get(input.subagent.runId)!)).toBe(true);
    expect(subagentRuns.get(input.subagent.runId)?.requesterSettleWake).toBeDefined();
  });
});
