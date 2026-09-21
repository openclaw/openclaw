import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseAsync,
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { SubagentLifecycleController } from "../registry/subagent-registry-lifecycle.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../registry/subagent-registry.store.sqlite.js";
import { settleSubagentCompletionDelivery } from "./subagent-completion-admission.store.js";
import { records, requesterWakeDriver } from "./subagent-completion-admission.test-helpers.js";
import {
  dismissSubagentCompletionDelivery,
  retrySubagentCompletionDelivery,
} from "./subagent-completion-delivery.js";

const resumeSubagentRun = vi.hoisted(() => vi.fn());
vi.mock("../registry/subagent-registry.js", () => ({ resumeSubagentRun }));
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("completed requester delivery replay fence", () => {
  beforeEach(() => {
    vi.stubEnv(
      "OPENCLAW_STATE_DIR",
      tempDirs.make("openclaw-completion-replay-", resolvePreferredOpenClawTmpDir()),
    );
    resumeSubagentRun.mockClear();
  });

  afterEach(async () => {
    for (const dir of tempDirs.dirs) {
      await closeOpenClawAgentDatabasesAsync(dir);
    }
    await closeOpenClawStateDatabaseAsync();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    closeOpenClawStateDatabaseForTest();
    vi.unstubAllEnvs();
  });

  async function reopenOwners() {
    await closeOpenClawStateDatabaseAsync();
    closeOpenClawStateDatabaseForTest();
    subagentRuns.clear();
    resetTaskRegistryForTests({ persist: false });
    openOpenClawStateDatabase();
    for (const [runId, entry] of loadSubagentRegistryFromSqlite()) {
      subagentRuns.set(runId, entry);
    }
    ensureTaskRegistryReady();
  }

  function runningOwner() {
    const input = records();
    input.task.status = "running";
    input.task.deliveryStatus = "pending";
    delete input.task.terminalOutcome;
    delete input.task.endedAt;
    input.subagent.execution = { status: "running", startedAt: input.task.createdAt };
    input.subagent.completion = { required: true };
    input.subagent.delivery = { status: "pending", generation: 1 };
    input.subagent.retainAttachmentsOnKeep = true;
    settleSubagentCompletionDelivery({ subagent: input.subagent, task: input.task });
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
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
      params.onDeliveryResult?.({
        delivered: false,
        path: "direct",
        reason: "message_tool_delivery_missing",
        disposition: "permanent_failure",
        error: "requester finished without required message tool delivery",
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
        generation: 1,
        payload: { childRunId: input.subagent.runId, task: input.task.task },
      });
      expect(getTaskById(input.task.taskId)).toMatchObject({
        status: "succeeded",
        terminalOutcome: "blocked",
        deliveryStatus: "failed",
      });
      expect(stored.requesterSettleWake).toBeUndefined();
      expect(stored.suppressCompletionDelivery).not.toBe(true);
      expect(driver.wake).not.toHaveBeenCalled();
    } finally {
      tail.resolve(undefined);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      driver.controller.clearScheduledResumeTimers();
    }
    await reopenOwners();
    input.subagent = subagentRuns.get(input.subagent.runId)!;
    const retained = structuredClone(input.subagent);
    const restored = requesterWakeDriver([input]);
    try {
      restored.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(restored.wake).not.toHaveBeenCalled();
      expect(input.subagent).toEqual(retained);

      // Older persisted ordinary wake markers are not permission to replay.
      input.subagent.requesterSettleWake = { status: "pending", attemptCount: 0 };
      saveSubagentRegistryToSqlite(subagentRuns);
      await reopenOwners();
      input.subagent = subagentRuns.get(input.subagent.runId)!;
      restored.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
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
      params.onDeliveryResult?.({
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
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      expect(driver.wake).not.toHaveBeenCalled();
    } finally {
      release.resolve(undefined);
      await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
      driver.controller.clearScheduledResumeTimers();
    }
  });

  it.each(["retry", "dismiss"] as const)(
    "keeps explicit %s available after lifecycle suspension and reopen",
    async (action) => {
      const { input, driver, reported, tail } = await completeWithMissingReceipt();
      try {
        await reported.promise;
      } finally {
        tail.resolve(undefined);
        await vi.waitFor(() => expect(getActiveGatewayRootWorkCount()).toBe(0));
        driver.controller.clearScheduledResumeTimers();
      }
      await reopenOwners();
      const before = subagentRuns.get(input.subagent.runId)!;
      const payload = structuredClone(before.delivery?.payload);
      expect(before.delivery?.status).toBe("suspended");
      if (action === "retry") {
        expect(await retrySubagentCompletionDelivery(input.task.taskId)).toMatchObject({
          ok: true,
          duplicateRisk: true,
        });
        expect(resumeSubagentRun).toHaveBeenCalledExactlyOnceWith(input.subagent.runId);
        await reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)?.delivery).toMatchObject({
          status: "pending",
          generation: 2,
          payload,
        });
        expect(subagentRuns.get(input.subagent.runId)?.delivery?.lastDropReason).toBeUndefined();
      } else {
        expect(
          await dismissSubagentCompletionDelivery(input.task.taskId, {
            discardTerminalDelivery: SubagentLifecycleController.discardTerminalDelivery,
          }),
        ).toMatchObject({ ok: true });
        await reopenOwners();
        expect(subagentRuns.get(input.subagent.runId)?.delivery?.status).toBe("discarded");
        expect(getTaskById(input.task.taskId)?.deliveryStatus).toBe("dismissed");
        expect(resumeSubagentRun).not.toHaveBeenCalled();
      }
    },
  );
});
