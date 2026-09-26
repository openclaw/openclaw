import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../registry/subagent-registry.store.sqlite.js";
import {
  records,
  requesterWakeDriver,
  seedSubagentCompletionDelivery,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = createTempDirTracker();

describe("completed requester delivery replay fence", () => {
  const env = captureEnv(["OPENCLAW_STATE_DIR"]);
  const settle = () => settleSubagentRegistryPersistenceWork();
  beforeEach(() => {
    // Failed resource cleanup retains the capture; retired directories only need removal retry.
    if (tempDirs.dirs.size > 0) {
      throw new Error("Previous completion replay fixture cleanup is incomplete");
    }
    setTestEnvValue(
      "OPENCLAW_STATE_DIR",
      tempDirs.make("openclaw-completion-replay-", resolvePreferredOpenClawTmpDir()),
    );
  });

  afterEach(async () => {
    const failures: unknown[] = [];
    try {
      await settle();
    } catch (error) {
      failures.push(error);
    }
    // Preserve stores and their environment while detached delivery still owns them.
    if (getActiveGatewayRootWorkCount() === 0) {
      try {
        for (const dir of tempDirs.dirs) {
          await closeOpenClawAgentDatabasesAsync(dir);
        }
        await closeOpenClawStateDatabaseAsync();
        subagentRuns.clear();
        closeOpenClawStateDatabaseForTest();
        // Keep failed removals tracked without retaining the retired fixture's environment.
        try {
          tempDirs.cleanup();
        } catch (error) {
          failures.push(error);
        }
        env.restore();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Subagent completion replay cleanup failed");
    }
  });

  async function reopenOwners() {
    await settle();
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
  }

  function runningOwner() {
    const input = records();
    input.subagent.execution = { status: "running", startedAt: input.subagent.createdAt };
    input.subagent.completion = { required: true };
    input.subagent.delivery = { status: "pending", generation: 1 };
    input.subagent.retainAttachmentsOnKeep = true;
    seedSubagentCompletionDelivery({ subagent: input.subagent });
    subagentRuns.set(input.subagent.runId, input.subagent);
    return input;
  }

  async function completeWithMissingReceipt() {
    const input = runningOwner();
    const reported = createDeferred();
    const tail = createDeferred();
    const driver = requesterWakeDriver([input]);
    driver.controller.options.runSubagentAnnounceFlow = vi.fn<
      typeof driver.controller.options.runSubagentAnnounceFlow
    >(async (params) => {
      await params.onDeliveryResult?.({
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        disposition: "permanent_failure",
        error: "requester finished without required message tool delivery",
        enqueuedAt: input.subagent.createdAt,
      });
      reported.resolve(undefined);
      await tail.promise;
      return "permanent_failure";
    });
    await driver.controller.completeSubagentRun({
      runId: input.subagent.runId,
      endedAt: Date.now(),
      outcome: { status: "ok" },
      reason: "subagent-complete",
      terminalReply: { disposition: "visible", text: "canonical result" },
      triggerCleanup: true,
    });
    return { input, driver, reported, tail };
  }

  it("atomically retains the lifecycle-produced block before the announce tail, then fences reopen", async () => {
    const { input, driver, reported, tail } = await completeWithMissingReceipt();
    try {
      await reported.promise;
      const stored = loadSubagentRegistryFromSqlite().get(input.subagent.runId)!;
      expect(stored.execution).toMatchObject({ status: "terminal", outcome: { status: "ok" } });
      expect(stored.delivery).toMatchObject({
        status: "suspended",
        suspendedReason: "permanent_failure",
        lastDropReason: "message_tool_delivery_missing",
        enqueuedAt: input.subagent.createdAt,
        generation: 1,
        payload: { childRunId: input.subagent.runId, task: input.subagent.task },
      });
      expect(stored.requesterSettleWake).toBeUndefined();
      expect(stored.suppressCompletionDelivery).not.toBe(true);
      expect(driver.wake).not.toHaveBeenCalled();
    } finally {
      tail.resolve(undefined);
      driver.controller.clearScheduledResumeTimers();
      await settle();
    }
    await reopenOwners();
    input.subagent = subagentRuns.get(input.subagent.runId)!;
    const retained = structuredClone(input.subagent);
    const restored = requesterWakeDriver([input]);
    try {
      restored.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
      await settle();
      expect(restored.wake).not.toHaveBeenCalled();
      expect(input.subagent).toEqual(retained);

      // Older persisted ordinary wake markers are not permission to replay.
      input.subagent.requesterSettleWake = { status: "pending", attemptCount: 0 };
      saveSubagentRegistryToSqlite(subagentRuns);
      await reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      restored.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
      await settle();
      expect(restored.wake).not.toHaveBeenCalled();

      // A separately admitted yield batch still owns real pending work.
      input.subagent.requesterSettleWake = {
        status: "pending",
        attemptCount: 0,
        requesterYieldBatch: true,
        rearmGeneration: 1,
        batchRunIds: [input.subagent.runId],
      };
      saveSubagentRegistryToSqlite(subagentRuns);
      restored.wake.mockResolvedValue(false);
      await restored.run(input.subagent);
      expect(restored.wake).toHaveBeenCalledTimes(1);
    } finally {
      restored.controller.clearScheduledResumeTimers();
      await settle();
    }
  });

  it("rechecks a wake that waited for admission while completion became blocked", async () => {
    const input = runningOwner();
    const driver = requesterWakeDriver([input]);
    const admitted = createDeferred();
    const release = createDeferred();
    const reported = createDeferred();
    const runWake = driver.controller.runRequesterSettleWake;
    driver.controller.runRequesterSettleWake = (entry, run) =>
      runWake(entry, async () => {
        admitted.resolve(undefined);
        await release.promise;
        return run();
      });
    driver.controller.options.runSubagentAnnounceFlow = vi.fn<
      typeof driver.controller.options.runSubagentAnnounceFlow
    >(async (params) => {
      await params.onDeliveryResult?.({
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        disposition: "permanent_failure",
      });
      reported.resolve(undefined);
      return "permanent_failure";
    });
    try {
      await driver.controller.completeSubagentRun({
        runId: input.subagent.runId,
        endedAt: Date.now(),
        outcome: { status: "ok" },
        reason: "subagent-complete",
        terminalReply: { disposition: "visible", text: "canonical result" },
        triggerCleanup: false,
      });
      // Admission must start from a real pending obligation, not a marker-less row.
      input.subagent.requesterSettleWake = { status: "pending", attemptCount: 0 };
      saveSubagentRegistryToSqlite(subagentRuns);
      driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
      await admitted.promise;
      expect(
        driver.controller.startSubagentAnnounceCleanupFlow(input.subagent.runId, input.subagent),
      ).toBe(true);
      await reported.promise;
      expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery?.status).toBe(
        "suspended",
      );
      release.resolve(undefined);
      await settle();
      expect(driver.wake).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      driver.controller.clearScheduledResumeTimers();
      await settle();
    }
  });
});
