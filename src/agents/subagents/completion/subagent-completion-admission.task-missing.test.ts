import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { logSlowSqliteCoordinatorWait } from "../../../infra/sqlite-transaction.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { flushLogger, getLogger, resetLogger, setLoggerOverride } from "../../../logging/logger.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady } from "../../../tasks/runtime-internal.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { SUBAGENT_ENDED_REASON_COMPLETE } from "../registry/subagent-lifecycle-events.js";
import { updateSubagentArchiveAtMs } from "../registry/subagent-registry-helpers.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "../registry/subagent-registry.store.sqlite.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import {
  armRequesterWake,
  records,
  requesterWakeDriver,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterAll);
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun: vi.fn() }));

describe("missing subagent completion tasks", () => {
  let database: OpenClawStateDatabase;
  const warnings = vi.fn();
  let detach: () => void;
  beforeAll(() => {
    const logDir = tempDirs.make("openclaw-completion-logs-", resolvePreferredOpenClawTmpDir());
    setLoggerOverride({
      level: "warn",
      consoleLevel: "silent",
      file: join(logDir, "warnings.log"),
    });
    detach = getLogger().attachTransport(warnings);
  });
  afterAll(() => {
    detach();
    resetLogger();
  });
  beforeEach(() => {
    warnings.mockClear();
    vi.useFakeTimers();
    const tempDir = tempDirs.make("openclaw-missing-completion-", resolvePreferredOpenClawTmpDir());
    vi.stubEnv("OPENCLAW_STATE_DIR", tempDir);
    database = openOpenClawStateDatabase();
  });
  afterEach(async () => {
    await flushLogger();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function reopenOwners() {
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    database = openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
    ensureTaskRegistryReady();
  }

  it.each([
    { path: "announce", expired: true, delivered: false },
    { path: "announce", expired: false, delivered: false },
    { path: "announce", expired: true, delivered: false, reportedFailure: true },
    { path: "requester wake", expired: true, delivered: false },
    { path: "requester wake", expired: true, delivered: true },
  ])(
    "retires a missing task after one $path attempt (expired=$expired, delivered=$delivered, callback=$reportedFailure) without restart replay",
    async ({ path, expired, delivered, reportedFailure }) => {
      const input = records();
      input.subagent.endedReason = SUBAGENT_ENDED_REASON_COMPLETE;
      input.subagent.execution.endedAt = Date.now() - 9 * 24 * 60 * 60_000;
      input.subagent.cleanup = "delete";
      input.subagent.spawnMode = delivered ? "session" : "run";
      updateSubagentArchiveAtMs(input.subagent);
      input.subagent.delivery = {
        status: "pending",
        deadlineAt: Date.now() + (expired ? -1 : 600_000),
      };
      input.subagent.retainAttachmentsOnKeep = true;
      if (path === "requester wake") {
        armRequesterWake(input);
        input.subagent.requesterSettleWake!.retireAfterSettle = true;
      } else if (!reportedFailure) {
        input.subagent.requesterTurnRunId = "finished-requester";
        input.subagent.requesterTurnYielded = true;
        input.subagent.retireAfterRequesterTurn = true;
      }
      settleSubagentCompletionDelivery({ ...input, databaseOptions: { database } });
      database.db.prepare("DELETE FROM task_runs WHERE task_id = ?").run(input.task.taskId);
      reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      const completion = structuredClone(input.subagent.completion);
      const driver = requesterWakeDriver([input]);
      const announce = vi.fn<typeof driver.controller.options.runSubagentAnnounceFlow>(
        async (params) => {
          if (reportedFailure) {
            await params.onDeliveryResult?.({
              delivered: false,
              path: "none",
              reason: "message_tool_delivery_missing",
              disposition: "permanent_failure",
            });
          }
          return "retryable";
        },
      );
      driver.controller.options.runSubagentAnnounceFlow = announce;
      driver.controller.options.callGateway = vi.fn().mockResolvedValue({ messages: [] });
      driver.controller.options.resumeSubagentRun = () => {
        driver.controller.startSubagentAnnounceCleanupFlow(input.subagent.runId, input.subagent);
      };
      driver.wake.mockImplementation(async (params) => {
        params.completeBatch([input.subagent], 1, {
          delivered,
          path: "none",
          error: "requester unavailable",
        });
        return false;
      });
      const attempt = () =>
        path === "announce"
          ? driver.controller.startSubagentAnnounceCleanupFlow(input.subagent.runId, input.subagent)
          : driver.controller.resumeRequesterSettleWake(
              input.subagent.runId,
              input.subagent,
              "restore",
            );
      try {
        // SQLite diagnostics share the root transport but are not completion retirement.
        logSlowSqliteCoordinatorWait(101, {
          databaseLabel: "synthetic-completion-fixture",
          operationLabel: "unrelated coordinator diagnostic",
        });
        attempt();
        await vi.advanceTimersByTimeAsync(300_000);
        expect(getActiveGatewayRootWorkCount()).toBe(0);
        expect(path === "announce" ? announce : driver.wake).toHaveBeenCalledOnce();
        const settled = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
        expect(settled.delivery).toMatchObject({
          status: "discarded",
          disposition: "permanent_failure",
          discardReason: "task-missing",
          discardedAt: expect.any(Number),
        });
        expect(settled.completion).toEqual(completion);
        expect(settled.requesterSettleWake).toBeUndefined();
        expect(settled.requesterTurnRunId).toBeUndefined();
        expect(settled.requesterTurnYielded).toBeUndefined();
        expect(settled.retireAfterRequesterTurn).toBeUndefined();
        expect(settled.cleanupCompletedAt).toEqual(expect.any(Number));
        if (input.subagent.spawnMode === "run") {
          expect(settled.archiveAtMs).toBeGreaterThan(settled.delivery!.discardedAt!);
        }
        driver.controller.clearScheduledResumeTimers();
        reopenOwners();
        input.subagent = subagentRuns.get(input.subagent.runId)!;
        expect(updateSubagentArchiveAtMs(input.subagent)).toBe(false);
        const restarted = requesterWakeDriver([input]);
        restarted.controller.options.runSubagentAnnounceFlow = announce;
        try {
          expect(
            restarted.controller.startSubagentAnnounceCleanupFlow(
              input.subagent.runId,
              input.subagent,
            ),
          ).toBe(false);
          restarted.controller.resumeRequesterSettleWake(
            input.subagent.runId,
            input.subagent,
            "restore",
          );
          await vi.advanceTimersByTimeAsync(300_000);
          expect(path === "announce" ? announce : driver.wake).toHaveBeenCalledOnce();
          expect(restarted.wake).not.toHaveBeenCalled();
          expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toEqual(
            input.subagent,
          );
          const retirementWarnings = warnings.mock.calls
            .map((call) => JSON.stringify(call))
            .filter((warning) => warning.includes("Subagent completion retired: task-missing"));
          expect(retirementWarnings).toHaveLength(1);
          expect(retirementWarnings[0]).toContain(input.subagent.runId);
        } finally {
          restarted.controller.clearScheduledResumeTimers();
        }
      } finally {
        driver.controller.clearScheduledResumeTimers();
      }
    },
  );
});
