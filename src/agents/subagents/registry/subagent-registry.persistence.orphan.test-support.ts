import { expect, it } from "vitest";
import { patchSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { callGateway } from "../../../gateway/call.js";
import { createRunningTaskRun } from "../../../tasks/detached-task-runtime.js";
import { createSubagentTaskBackingDetail } from "../../../tasks/task-backing-authority.js";
import { listTaskRecordPage } from "../../../tasks/task-registry-query.js";
import {
  configureTaskRegistryMaintenance,
  runTaskRegistryMaintenance,
} from "../../../tasks/task-registry.maintenance.js";
import {
  configureTaskRegistryRuntime,
  getTaskRegistryStore,
} from "../../../tasks/task-registry.store.js";
import { findTaskByRunIdForStatus } from "../../../tasks/task-status-access.js";
import { settleSubagentRegistryPersistenceWork } from "./subagent-registry.persistence.test-support.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import { addSubagentRunForTests, testing } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

export function registerSubagentOrphanTaskCases({
  writePersistedRegistry,
  writeChildSessionEntry,
  restartRegistry,
  waitForRegistryWork,
}: {
  writePersistedRegistry: (
    persisted: Record<string, unknown>,
    opts?: { seedChildSessions?: boolean },
  ) => Promise<void>;
  writeChildSessionEntry: (params: {
    sessionKey: string;
    sessionId?: string;
    updatedAt?: number;
    abortedLastRun?: boolean;
  }) => Promise<string>;
  restartRegistry: () => void;
  waitForRegistryWork: (predicate: () => boolean | Promise<boolean>) => Promise<void>;
}) {
  it("settles the linked task before retiring a stale orphan restored with a retained session", async () => {
    const now = Date.now();
    const runId = "run-stale-unended-restore";
    const childSessionKey = "agent:main:subagent:stale-unended-restore";
    await writePersistedRegistry({
      version: 2,
      runs: {
        [runId]: {
          runId,
          childSessionKey,
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          task: "stale unended restored work",
          cleanup: "keep",
          createdAt: now - 3 * 60 * 60 * 1_000,
          startedAt: now - 3 * 60 * 60 * 1_000,
        },
      },
    });

    expect(
      createRunningTaskRun({
        runtime: "subagent",
        sourceId: runId,
        runId,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        childSessionKey,
        task: "stale unended restored work",
        startedAt: now - 3 * 60 * 60 * 1_000,
        lastEventAt: now - 3 * 60 * 60 * 1_000,
        deliveryStatus: "pending",
        detail: createSubagentTaskBackingDetail(1),
      }),
    ).not.toBeNull();

    restartRegistry();
    await testing.sweepOnceForTests();
    await waitForRegistryWork(() => findTaskByRunIdForStatus(runId)?.status === "failed");
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({
      status: "failed",
      error: expect.stringContaining("orphan"),
      endedAt: expect.any(Number),
    });
    const activePage = await listTaskRecordPage({
      offset: 0,
      limit: 100,
      statuses: ["running", "queued"],
      sessionKey: "agent:main:main",
    });
    expect(activePage).toMatchObject({ ok: true, value: { tasks: [] } });
    expect(callGateway).not.toHaveBeenCalledWith(expect.objectContaining({ method: "agent" }));
  });

  it("retries orphan task settlement before completing cleanup after a task-store failure", async () => {
    const now = Date.now();
    const runId = "run-orphan-task-write-failure";
    const childSessionKey = "agent:main:subagent:orphan-task-write-failure";
    await writePersistedRegistry(
      {
        runs: {
          [runId]: {
            runId,
            taskRunId: runId,
            generation: 1,
            childSessionKey,
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            task: "settle orphan task before cleanup",
            cleanup: "keep",
            expectsCompletionMessage: false,
            createdAt: now - 10_000,
            startedAt: now - 10_000,
          },
        },
      },
      { seedChildSessions: false },
    );
    const task = createRunningTaskRun({
      runtime: "subagent",
      runId,
      childSessionKey,
      ownerKey: "agent:main:main",
      scopeKind: "session",
      task: "settle orphan task before cleanup",
      startedAt: now - 10_000,
      deliveryStatus: "not_applicable",
      detail: createSubagentTaskBackingDetail(1),
    });
    expect(task).not.toBeNull();
    const store = getTaskRegistryStore();
    let rejectTerminalWrites = true;
    let rejectedWrites = 0;
    configureTaskRegistryRuntime({
      store: {
        ...store,
        upsertTaskWithDeliveryState(params) {
          if (
            params.task.taskId === task?.taskId &&
            params.task.status === "failed" &&
            rejectTerminalWrites
          ) {
            rejectedWrites += 1;
            throw new Error("injected task settlement failure");
          }
          store.upsertTaskWithDeliveryState(params);
        },
      },
    });
    restartRegistry();
    await waitForRegistryWork(() => rejectedWrites > 0);
    await settleSubagentRegistryPersistenceWork();
    expect(findTaskByRunIdForStatus(runId)?.status).toBe("running");
    expect(loadSubagentRegistryFromSqlite().get(runId)?.cleanupCompletedAt).toBeUndefined();
    rejectTerminalWrites = false;
    await waitForRegistryWork(() => findTaskByRunIdForStatus(runId)?.status === "failed");
    await waitForRegistryWork(
      () => loadSubagentRegistryFromSqlite().get(runId)?.cleanupCompletedAt !== undefined,
    );
  });

  it("reconciles a previously stranded registry-backed task despite its retained running session", async () => {
    const runId = "run-already-pruned";
    const childSessionKey = "agent:main:subagent:already-pruned";
    const startedAt = Date.now() - 3 * 60 * 60_000;
    await writePersistedRegistry({ runs: {} });
    const storePath = await writeChildSessionEntry({ sessionKey: childSessionKey });
    await patchSessionEntryCore({ storePath, sessionKey: childSessionKey }, () => ({
      status: "running",
      startedAt,
    }));
    expect(
      createRunningTaskRun({
        runtime: "subagent",
        runId,
        childSessionKey,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "previously stranded work",
        startedAt,
        lastEventAt: startedAt,
        deliveryStatus: "not_applicable",
        detail: createSubagentTaskBackingDetail(1),
      }),
    ).not.toBeNull();
    configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
    expect((await runTaskRegistryMaintenance()).reconciled).toBe(1);
    expect(findTaskByRunIdForStatus(runId)).toMatchObject({
      status: "lost",
      endedAt: expect.any(Number),
    });
  });

  it.each([
    "yielded",
    "queued",
    "recovering",
    "replacement",
    "live-memory",
    "terminal-delivery",
  ] as const)("maintenance preserves a registry-backed task with a %s owner", async (state) => {
    const taskRunId = `task-owner-${state}`;
    const runId = state === "replacement" ? "replacement-run" : taskRunId;
    const childSessionKey = `agent:main:subagent:owner-${state}`;
    const startedAt = Date.now() - 3 * 60 * 60_000;
    const entry: SubagentRunRecord = {
      runId,
      taskRunId,
      childSessionKey,
      generation: state === "replacement" ? 2 : 1,
      requesterSessionKey: "agent:main:main",
      requesterDisplayKey: "main",
      task: "preserve owned work",
      cleanup: "keep",
      createdAt: startedAt,
      execution: {
        status:
          state === "queued"
            ? "queued"
            : state === "recovering"
              ? "interrupted"
              : state === "yielded" || state === "terminal-delivery"
                ? "terminal"
                : "running",
        startedAt,
        ...(state === "yielded" || state === "terminal-delivery"
          ? { endedAt: startedAt + 1_000 }
          : {}),
      },
      ...(state === "yielded" ? { pauseReason: "sessions_yield" } : {}),
      completion: { required: state === "terminal-delivery" },
      delivery: { status: "pending" },
    };
    await writePersistedRegistry({ runs: state === "live-memory" ? {} : { [runId]: entry } });
    if (state === "live-memory") {
      addSubagentRunForTests(entry);
    }
    expect(
      createRunningTaskRun({
        runtime: "subagent",
        runId: taskRunId,
        childSessionKey,
        ownerKey: "agent:main:main",
        scopeKind: "session",
        task: "preserve owned work",
        startedAt,
        lastEventAt: startedAt,
        deliveryStatus: "not_applicable",
        detail: createSubagentTaskBackingDetail(entry.generation!),
      }),
    ).not.toBeNull();
    configureTaskRegistryMaintenance({ runtimeAuthoritative: true });
    expect((await runTaskRegistryMaintenance()).reconciled).toBe(0);
    expect(findTaskByRunIdForStatus(taskRunId)?.status).toBe("running");
  });
}
