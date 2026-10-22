import assert from "node:assert/strict";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createDeferred, withinTest } from "../../../../test/helpers/promise.js";
import { createTempDirTracker } from "../../../../test/helpers/temp-dir.js";
import * as config from "../../../config/runtime-snapshot.js";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { replaceSessionEntry } from "../../../config/sessions/session-accessor.js";
import { resolvePreferredOpenClawTmpDir } from "../../../infra/tmp-openclaw-dir.js";
import { getActiveGatewayRootWorkCount } from "../../../process/gateway-work-admission.js";
import { closeOpenClawAgentDatabasesAsync } from "../../../state/openclaw-agent-db.js";
import * as stateDb from "../../../state/openclaw-state-db.js";
import { captureEnv, setTestEnvValue } from "../../../test-utils/env.js";
import { resolveRequesterRecoveryDelivery } from "../announce/subagent-announce-completion-delivery.js";
import { subagentRuns } from "../registry/subagent-registry-memory.js";
import { mutateSubagentRuns } from "../registry/subagent-registry-persistence.js";
import {
  loadSubagentRegistryFromSqlite,
  saveSubagentRegistryToSqlite,
} from "../registry/subagent-registry-state.fixture.test-support.js";
import { settleSubagentRegistryPersistenceWork } from "../registry/subagent-registry.persistence.test-support.js";
import {
  records,
  readCompletionSystemEvents,
  reopenCompletionFixtureOwners,
  requesterWakeDriver,
  seedSubagentCompletionOwner,
} from "./subagent-completion-admission.test-helpers.js";

const tempDirs = createTempDirTracker();

const env = captureEnv(["OPENCLAW_STATE_DIR"]);
const settle = settleSubagentRegistryPersistenceWork;
beforeEach(() => {
  // Failed resource cleanup retains the capture; retired directories only need removal retry.
  if (tempDirs.dirs.size > 0) {
    throw new Error("Previous completion replay fixture cleanup is incomplete");
  }
  setTestEnvValue(
    "OPENCLAW_STATE_DIR",
    tempDirs.make("openclaw-completion-replay-", resolvePreferredOpenClawTmpDir()),
  );
  config.setRuntimeConfigSnapshot({});
});

afterEach(async () => {
  const failures: unknown[] = [];
  const collect = async (work: () => unknown) => {
    try {
      await work();
    } catch (error) {
      failures.push(error);
    }
  };
  await collect(settle);
  // Preserve stores and their environment while detached delivery still owns them.
  if (getActiveGatewayRootWorkCount() === 0) {
    await collect(async () => {
      for (const dir of tempDirs.dirs) {
        await closeOpenClawAgentDatabasesAsync(dir);
      }
      await stateDb.closeOpenClawStateDatabaseAsync();
      subagentRuns.clear();
      stateDb.closeOpenClawStateDatabaseForTest();
      config.clearRuntimeConfigSnapshot();
      // Keep failed removals tracked without retaining the retired fixture's environment.
      await collect(tempDirs.cleanup);
      env.restore();
    });
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
  await reopenCompletionFixtureOwners();
}

async function runningOwner(signal: AbortSignal, holdTail = false, recoveredRequester = false) {
  const input = records();
  const { requesterAgentId: agentId, requesterSessionKey: sessionKey } = input.subagent;
  await replaceSessionEntry(
    { agentId, sessionKey, storePath: resolveSessionStorePathCore(undefined, { agentId }) },
    { sessionId: "requester-session", updatedAt: Date.now() },
  );
  input.subagent.execution = { status: "running", startedAt: input.subagent.createdAt };
  input.subagent.completion = { required: true };
  input.subagent.delivery = { status: "pending", generation: 1 };
  input.subagent.retainAttachmentsOnKeep = true;
  seedSubagentCompletionOwner(input);
  const driver = requesterWakeDriver([input]);
  const reported = createDeferred();
  const tail = createDeferred();
  driver.controller.options.runSubagentAnnounceFlow = vi.fn<
    typeof driver.controller.options.runSubagentAnnounceFlow
  >(async (params) => {
    const recovery = recoveredRequester
      ? resolveRequesterRecoveryDelivery(
          {
            sessionId: "requester-session",
            updatedAt: Date.now(),
            restartRecoveryTerminalRunIds: ["recovered-requester"],
          },
          "recovered-requester",
        )
      : undefined;
    if (recoveredRequester) {
      assert(recovery?.kind === "delivery");
    }
    await params.onDeliveryResult?.(
      recovery?.kind === "delivery"
        ? recovery.delivery
        : {
            delivered: false,
            path: "direct",
            reason: "message_tool_delivery_missing",
            disposition: "permanent_failure",
            ...(holdTail
              ? {
                  error: "requester finished without required message tool delivery",
                  enqueuedAt: input.subagent.createdAt,
                }
              : {}),
          },
    );
    reported.resolve(undefined);
    if (holdTail) {
      await tail.promise;
    }
    return "permanent_failure";
  });
  const complete = (triggerCleanup: boolean) =>
    withinTest(
      driver.controller.completeSubagentRun({
        runId: input.subagent.runId,
        endedAt: Date.now(),
        outcome: { status: "ok" },
        reason: "subagent-complete",
        terminalReply: { disposition: "visible", text: "canonical result" },
        triggerCleanup,
      }),
      signal,
    );
  const close = async () => {
    tail.resolve(undefined);
    driver.controller.clearRuntimeState();
    await settle();
  };
  return { input, driver, reported, complete, close };
}

it("does not wake again after ordinary announcement recovery permanently fails", async ({
  signal,
}) => {
  const { input, driver, reported, complete, close } = await runningOwner(signal, false, true);
  try {
    await complete(true);
    await withinTest(reported.promise, signal);
    await settle();
    expect(driver.wake).not.toHaveBeenCalled();
  } finally {
    await close();
  }
  await reopenOwners();
  const stored = subagentRuns.get(input.subagent.runId)!;
  expect(stored.completion?.resultText).toBe("canonical result");
  expect(stored.delivery).toMatchObject({
    status: "suspended",
    disposition: "permanent_failure",
    suspendedReason: "permanent_failure",
    lastDropReason: "visible_reply_missing",
    lastError: expect.stringContaining(
      "recovered requester completed without durable final delivery evidence",
    ),
  });
  expect(stored.requesterSettleWake).toBeUndefined();
  expect(readCompletionSystemEvents(stateDb.openOpenClawStateDatabase())).toEqual([]);
  input.subagent = stored;
  const restored = requesterWakeDriver([input]);
  try {
    restored.controller.resumeRequesterSettleWake(stored.runId, stored);
    await settle();
    expect(restored.wake).not.toHaveBeenCalled();

    // An explicit yield batch still owns real work after failed recovery.
    stored.requesterSettleWake = {
      status: "pending",
      attemptCount: 0,
      requesterYieldBatch: true,
      rearmGeneration: 1,
      batchRunIds: [stored.runId],
    };
    saveSubagentRegistryToSqlite(subagentRuns);
    restored.wake.mockResolvedValue(false);
    await restored.run(stored);
    expect(restored.wake).toHaveBeenCalledTimes(1);
  } finally {
    restored.controller.clearRuntimeState();
    await settle();
  }
});

it("persists a blocked completion across the announce tail and reopen", async ({ signal }) => {
  const { input, driver, reported, complete, close } = await runningOwner(signal, true);
  try {
    await complete(true);
    await withinTest(reported.promise, signal);
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
    await close();
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
    stateDb
      .openOpenClawStateDatabase()
      .db.prepare(
        "UPDATE subagent_runs SET payload_json = json_set(payload_json, '$.requesterSettleWake', json('{}')) WHERE run_id = ?",
      )
      .run(input.subagent.runId);
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
    restored.controller.clearRuntimeState();
    await settle();
  }
});

it("rechecks blocked completion after wake admission", async ({ signal }) => {
  const { input, driver, reported, complete, close } = await runningOwner(signal);
  const admitted = createDeferred();
  const release = createDeferred();
  const runWake = driver.controller.runRequesterSettleWake;
  driver.controller.runRequesterSettleWake = (entry, run, isCurrent) =>
    runWake(
      entry,
      async () => {
        admitted.resolve(undefined);
        await release.promise;
        return run();
      },
      isCurrent,
    );
  try {
    await complete(false);
    // Admission must start from the committed terminal row and a pending obligation.
    await mutateSubagentRuns([input.subagent.runId], (rows) => {
      const next = structuredClone(rows.get(input.subagent.runId)!);
      next.requesterSettleWake = { status: "pending", attemptCount: 0 };
      return { value: undefined, postimages: new Map([[next.runId, next]]) };
    });
    input.subagent = subagentRuns.get(input.subagent.runId)!;
    driver.controller.resumeRequesterSettleWake(input.subagent.runId, input.subagent);
    await withinTest(admitted.promise, signal);
    expect(driver.controller.startSubagentAnnounceCleanupFlow(input.subagent)).toBe(true);
    await withinTest(reported.promise, signal);
    expect(loadSubagentRegistryFromSqlite().get(input.subagent.runId)?.delivery?.status).toBe(
      "suspended",
    );
    release.resolve(undefined);
    await settle();
    expect(driver.wake).not.toHaveBeenCalled();
  } finally {
    release.resolve(undefined);
    await close();
  }
});
