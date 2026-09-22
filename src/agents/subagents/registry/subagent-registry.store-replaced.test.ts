import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { createGatewayRequestContext } from "../../../gateway/server-request-context.js";
import { makeContextParams } from "../../../gateway/server-request-context.test-support.js";
import { resetHeartbeatEventsForTest } from "../../../infra/heartbeat-events.js";
import { publishSystemEventStoreResolver } from "../../../infra/system-event-ownership.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../../state/openclaw-state-db.js";
import { ensureTaskRegistryReady, getTaskById } from "../../../tasks/runtime-internal.js";
import { publishTaskRecordAfterAtomicStore } from "../../../tasks/task-registry.js";
import { resetTaskRegistryForTests } from "../../../tasks/task-runtime.test-helpers.js";
import { maybeWakeRequesterAfterAllChildrenSettled } from "../announce/subagent-announce.requester-settle-wake.js";
import {
  blockSubagentCompletionDelivery,
  publishCommittedRecords,
  settleRequesterCompletionBatch,
  settleSubagentCompletionDelivery,
} from "../completion/subagent-completion-admission.store.js";
import {
  failedRecords,
  records,
} from "../completion/subagent-completion-admission.test-helpers.js";
import { loadPendingFinalDeliveryPayload } from "./subagent-registry-lifecycle-delivery.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import {
  activateSubagentRegistry,
  initSubagentRegistry,
  leasePendingAgentSteeringItems,
  resetSubagentRegistryForTests,
} from "./subagent-registry.test-helpers.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
vi.mock("../../../config/config.js", { spy: true });

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubEnv("OPENCLAW_STATE_DIR", tempDirs.make("openclaw-child-store-replaced-"));
  resetSubagentRegistryForTests({ persist: false });
  vi.mocked(getRuntimeConfig).mockReturnValue({});
  publishSystemEventStoreResolver(() => "original-store");
});

afterEach(() => {
  resetSubagentRegistryForTests({ persist: false });
  resetTaskRegistryForTests({ persist: false });
  publishSystemEventStoreResolver(undefined);
  resetHeartbeatEventsForTest();
  vi.mocked(getRuntimeConfig).mockReset();
  closeOpenClawStateDatabaseForTest();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

it.each([false, true])(
  "suspends an original-store child that completes after replacement without a new alert (overlapping new-store wake: %s)",
  async (overlappingWake) => {
    const input = records();
    const now = Date.now();
    const taskIds = new Map([[input.subagent.runId, input.task.taskId]]);
    let replacementWake: typeof input.subagent.requesterSettleWake;
    if (overlappingWake) {
      input.subagent.execution.endedAt = now + 2_000;
      input.task.endedAt = now + 2_000;
    }
    input.subagent.requesterStorePath = "original-store";
    input.subagent.delivery = {
      status: "pending",
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    input.subagent.requesterSettleWake = overlappingWake
      ? { status: "pending", attemptCount: 0 }
      : {
          status: "pending",
          attemptCount: 0,
          requesterYieldBatch: true,
          rearmGeneration: 1,
          batchRunIds: [input.subagent.runId],
        };
    const running = structuredClone(input);
    running.subagent.execution = { status: "running", startedAt: input.subagent.createdAt };
    running.subagent.completion = { required: true };
    running.task.status = "running";
    running.task.endedAt = undefined;
    running.task.terminalOutcome = undefined;
    const database = openOpenClawStateDatabase();
    settleSubagentCompletionDelivery({ subagent: running.subagent, task: running.task });
    publishCommittedRecords(running.subagent, running.task);
    publishSystemEventStoreResolver(() => "replacement-store");
    expect(subagentRuns.get(input.subagent.runId)?.execution.status).toBe("running");

    if (overlappingWake) {
      vi.setSystemTime(now + 1_000);
      const replacement = records();
      replacement.task.taskId = "replacement-task";
      replacement.task.runId = "replacement-task-run";
      replacement.task.childSessionKey = "agent:main:subagent:replacement";
      replacement.task.createdAt = replacement.subagent.createdAt = now + 1_000;
      replacement.task.endedAt = replacement.subagent.execution.endedAt = now + 1_500;
      replacement.task.notifyPolicy = "silent";
      replacement.subagent.runId = "replacement-run";
      replacement.subagent.taskRunId = replacement.task.runId;
      replacement.subagent.childSessionKey = replacement.task.childSessionKey;
      replacement.subagent.requesterStorePath = "replacement-store";
      replacement.subagent.delivery = { status: "pending" };
      settleSubagentCompletionDelivery({ subagent: replacement.subagent, task: replacement.task });
      publishCommittedRecords(replacement.subagent, replacement.task);
      expect(
        blockSubagentCompletionDelivery({
          subagent: expectDefined(subagentRuns.get(replacement.subagent.runId), "new-store child"),
          taskId: replacement.task.taskId,
          reason: "completion delivery expired",
          suspendedReason: "expiry",
        }),
      ).toBe(true);
      replacementWake = structuredClone(
        subagentRuns.get(replacement.subagent.runId)?.requesterSettleWake,
      );
      expect(replacementWake).toMatchObject({ status: "pending" });
      taskIds.set(replacement.subagent.runId, replacement.task.taskId);
      vi.setSystemTime(now + 2_000);
    }

    settleSubagentCompletionDelivery({ subagent: input.subagent, task: input.task });
    publishCommittedRecords(input.subagent, input.task);
    const settledEntry = expectDefined(
      subagentRuns.get(input.subagent.runId),
      "late terminal child",
    );
    expect(
      await maybeWakeRequesterAfterAllChildrenSettled({
        requesterSessionKey: input.subagent.requesterSessionKey,
        settledEntry,
        transitionBatch: () => {
          throw new Error("a replaced store must not admit a delivery attempt");
        },
        completeBatch: (batch, _generation, outcome, onCommitted) => {
          settleRequesterCompletionBatch({
            entries: batch.map((subagent) => ({
              subagent,
              taskId: expectDefined(taskIds.get(subagent.runId), "batch task owner"),
            })),
            outcome: expectDefined(outcome, "store replacement disposition"),
            isCurrent: () => batch.every((entry) => subagentRuns.get(entry.runId) === entry),
          });
          onCommitted?.();
        },
      }),
    ).toBe(false);
    if (overlappingWake) {
      expect(loadSubagentRegistryFromSqlite().get("replacement-run")?.requesterSettleWake).toEqual(
        replacementWake,
      );
    }
    expect(getTaskById(input.task.taskId)).toMatchObject({
      status: "succeeded",
      terminalOutcome: "succeeded",
    });
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)).toMatchObject({
      completion: { resultText: "canonical result" },
      delivery: {
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
      },
    });
  },
);

it.each(["same", "replaced", "restore", "unknown", "failed", "delivered"] as const)(
  "keeps automatic child notification disposition through store publication: %s",
  async (change) => {
    const input = change === "failed" ? failedRecords("failed", { status: "error" }) : records();
    input.subagent.requesterStorePath = change === "unknown" ? undefined : "original-store";
    input.subagent.controllerStorePath = change === "unknown" ? undefined : "original-store";
    input.subagent.cleanupCompletedAt = undefined;
    input.subagent.delivery = {
      status: change === "delivered" ? "delivered" : "pending",
      ...(change === "delivered" ? { deliveredAt: Date.now(), announcedAt: Date.now() } : {}),
      payload: loadPendingFinalDeliveryPayload(input.subagent),
    };
    const taskOutcome = {
      status: input.task.status,
      terminalOutcome: input.task.terminalOutcome,
      error: input.task.error,
    };
    const database = openOpenClawStateDatabase();
    settleSubagentCompletionDelivery({ subagent: input.subagent, task: input.task });
    const receipt = expectDefined(
      loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery,
      "persisted notification receipt",
    );
    subagentRuns.set(input.subagent.runId, input.subagent);
    ensureTaskRegistryReady();
    publishTaskRecordAfterAtomicStore(input.task);
    initSubagentRegistry();
    if (change === "restore") {
      resetSubagentRegistryForTests({ persist: false });
      publishSystemEventStoreResolver(() => "replacement-store");
      initSubagentRegistry();
      const context = createGatewayRequestContext(makeContextParams());
      context.resolveGatewayContext = () => context;
      activateSubagentRegistry(() => context);
    } else {
      publishSystemEventStoreResolver(() =>
        change === "same" || change === "unknown" ? "original-store" : "replacement-store",
      );
    }
    publishSystemEventStoreResolver(() => "original-store");
    const persisted = loadSubagentRegistryFromSqlite().get(input.subagent.runId);
    if (change === "unknown") {
      expect(persisted?.requesterStorePath).toBeUndefined();
      expect(persisted?.controllerStorePath).toBeUndefined();
    }
    expect(persisted?.completion?.resultText).toBe("canonical result");
    const task = getTaskById(input.task.taskId);
    expect({
      status: task?.status,
      terminalOutcome: task?.terminalOutcome,
      error: task?.error,
    }).toEqual(taskOutcome);
    expect(
      database.db
        .prepare("SELECT id FROM delivery_queue_entries WHERE entry_kind = 'systemEvent'")
        .all(),
    ).toEqual([]);
    if (change === "delivered") {
      expect(persisted?.delivery).toEqual(receipt);
    } else if (change !== "same") {
      expect(persisted?.delivery).toMatchObject({
        status: "suspended",
        disposition: "intentional_non_delivery",
        lastError: "store replaced",
        payload: receipt.payload,
      });
      expect(persisted?.requesterSettleWake).toBeUndefined();
    }
    const lease = await leasePendingAgentSteeringItems({
      requesterSessionKey: input.subagent.requesterSessionKey,
      leaseId: "after-store-publication",
    });
    if (change === "same") {
      expect(lease?.prompt).toContain("canonical result");
    } else {
      expect(lease).toBeUndefined();
    }
  },
);
