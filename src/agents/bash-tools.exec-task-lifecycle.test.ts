import { writeFile } from "node:fs/promises";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { getProcessSupervisor } from "../process/supervisor/index.js";
import { captureOpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.js";
import { getTaskExecutionObservation } from "../tasks/task-execution-observation.js";
import { prepareTaskRegistryRead } from "../tasks/task-registry-read.js";
import { createTaskRecord, getTaskById, listTasksForOwnerKey } from "../tasks/task-registry.js";
import { onTaskRegistryChange } from "../tasks/task-registry.store.js";
import { loadTaskRegistryStateFromSqliteReadOnly } from "../tasks/task-registry.store.sqlite.js";
import { resetTaskRegistryForTests } from "../tasks/task-registry.test-support.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { holdStateDatabaseWriteTransaction } from "../test-utils/state-database-contention.js";
import { getSession, waitForExecScope } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import { createExecTool } from "./bash-tools.exec-run.js";
import * as taskTracking from "./bash-tools.exec-task-tracking.js";

afterEach(() => {
  resetProcessRegistryForTests();
  resetTaskRegistryForTests({ persist: false });
});

function quietBackgroundCommand(workspaceDir: string, sessionKey: string) {
  const tool = createExecTool({
    host: "gateway",
    security: "full",
    ask: "off",
    cwd: workspaceDir,
    sessionKey,
    scopeKey: sessionKey,
    notifyOnExit: false,
  });
  // Host exec closes stdin. The durable gate also covers release before startup.
  const releaseFile = path.join(workspaceDir, "release-quiet-exec");
  const source = [
    `const fs = require("node:fs"); const gate = ${JSON.stringify(releaseFile)};`,
    "const watcher = fs.watch(process.cwd(), () => { if (fs.existsSync(gate)) watcher.close(); });",
    "if (fs.existsSync(gate)) watcher.close();",
  ].join(" ");
  return {
    tool,
    command: `${JSON.stringify(process.execPath)} -e ${JSON.stringify(source)}`,
    release: () => writeFile(releaseFile, ""),
  };
}

it("settles a real quiet background command in the ledger without a completion notification", async () => {
  await withOpenClawTestState({ layout: "home", scenario: "minimal" }, async ({ workspaceDir }) => {
    resetTaskRegistryForTests({ persist: false });
    const sessionKey = "agent:main:quiet-exec-task";
    const { tool, command, release } = quietBackgroundCommand(workspaceDir, sessionKey);
    try {
      const result = await tool.execute("quiet-background", { command, background: true });
      expect(result.details.status).toBe("running");
      if (result.details.status !== "running") {
        throw new Error("expected background command");
      }
      const processSession = getSession(result.details.sessionId);
      const rows = listTasksForOwnerKey(sessionKey);
      expect(rows).toHaveLength(1);
      const task = rows[0]!;
      expect(task).toMatchObject({ status: "running", task: command });
      expect(getTaskExecutionObservation(task)).toMatchObject({ state: "running" });
      if (!task.runId) {
        throw new Error("Expected the background task's run identity");
      }
      const otherOwner = "agent:main:unrelated-exec-owner";
      const unrelated = createTaskRecord({
        runtime: "cli",
        requesterSessionKey: otherOwner,
        ownerKey: otherOwner,
        scopeKind: "session",
        runId: task.runId,
        task: "Unrelated CLI task sharing the run ID",
        status: "running",
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
      });
      if (!unrelated) {
        throw new Error("Expected the unrelated same-run task");
      }
      expect(unrelated.taskId).not.toBe(task.taskId);
      await release();
      await waitForExecScope(sessionKey);
      const completed = getTaskById(task.taskId)!;
      expect(completed).toMatchObject({
        status: "succeeded",
        terminalSummary: "Command completed",
        detail: { exitCode: 0 },
      });
      expect(getTaskExecutionObservation(completed)).toEqual({ state: "finished" });
      expect(getTaskById(unrelated.taskId)).toMatchObject({
        status: "running",
        ownerKey: otherOwner,
        runId: task.runId,
      });
      expect(loadTaskRegistryStateFromSqliteReadOnly().tasks.get(unrelated.taskId)).toMatchObject({
        status: "running",
        ownerKey: otherOwner,
        runId: task.runId,
      });
      expect(processSession?.aggregated).toBe("");
    } finally {
      await release();
      await waitForExecScope(sessionKey);
      resetTaskRegistryForTests({ persist: false });
    }
  });
});

it.each(["creation", "finalization"] as const)(
  "keeps real background exec responsive during task %s and joins its terminal ledger write",
  async (phase) => {
    await withOpenClawTestState(
      { layout: "home", scenario: "minimal" },
      async ({ workspaceDir }) => {
        resetTaskRegistryForTests({ persist: false });
        await prepareTaskRegistryRead();
        const sessionKey = `agent:main:contended-exec-${phase}`;
        const { tool, command, release } = quietBackgroundCommand(workspaceDir, sessionKey);
        const context = captureOpenClawStateWorkerContext();
        let holder: ReturnType<typeof holdStateDatabaseWriteTransaction> | undefined;
        const holdWriter = async () => {
          // The worker watchdog releases a blocked old implementation; success
          // depends on the atomic ordering flag, never on a measured duration.
          holder = holdStateDatabaseWriteTransaction(context.admission.databasePath, 10_000);
          await holder.ready;
        };
        const checkpoint = createDeferred<number>();
        let checkpointArmed = false;
        let heartbeat: NodeJS.Immediate | undefined;
        const armCheckpoint = () => {
          if (checkpointArmed) {
            return;
          }
          checkpointArmed = true;
          const held = holder;
          if (!held) {
            throw new Error("Expected native writer contention before the ledger operation");
          }
          // Arming before tool.execute would let asynchronous preflight satisfy
          // this checkpoint before the original synchronous ledger call begins.
          heartbeat = setImmediate(() => checkpoint.resolve(Atomics.load(held.released, 0)));
        };
        const create = taskTracking.createBackgroundExecTask;
        const finalize = taskTracking.finalizeBackgroundExecTask;
        const observeCreation = vi
          .spyOn(taskTracking, "createBackgroundExecTask")
          .mockImplementation((params) => {
            if (phase === "creation" && params.sessionKey === sessionKey) {
              armCheckpoint();
            }
            return create(params);
          });
        const observeFinalization = vi
          .spyOn(taskTracking, "finalizeBackgroundExecTask")
          .mockImplementation((params) => {
            if (phase === "finalization" && params.handle?.sessionKey === sessionKey) {
              armCheckpoint();
            }
            return finalize(params);
          });
        const supervisor = getProcessSupervisor();
        const spawn = supervisor.spawn.bind(supervisor);
        const spawned = createDeferred<Awaited<ReturnType<typeof spawn>>>();
        const observeSpawn = vi.spyOn(supervisor, "spawn").mockImplementation(async (input) => {
          const run = await spawn(input);
          if (input.scopeKey === sessionKey) {
            // Preflight is complete and the quiet child is alive. Registration
            // cannot enter until this exact native handle returns to exec.
            if (phase === "creation") {
              await holdWriter();
            }
            spawned.resolve(run);
          }
          return run;
        });
        const publications: string[] = [];
        const stop = onTaskRegistryChange((event) => {
          if (
            event?.kind === "upserted" &&
            event.task.ownerKey === sessionKey &&
            publications.at(-1) !== event.task.status
          ) {
            publications.push(event.task.status);
          }
        });
        let execution: ReturnType<typeof tool.execute> | undefined;
        let scope: Promise<void> | undefined;
        let executionSettled = false;
        let scopeSettled = false;
        try {
          execution = tool.execute(`contended-${phase}`, { command, background: true });
          void execution.then(
            () => {
              executionSettled = true;
            },
            () => {
              executionSettled = true;
            },
          );
          if (phase === "finalization") {
            expect((await execution).details.status).toBe("running");
            await holdWriter();
          }
          const run = await withTestTimeout(
            spawned.promise,
            15_000,
            "Exec did not reach native spawn",
          );
          scope = waitForExecScope(sessionKey).then(() => {
            scopeSettled = true;
          });
          if (phase === "finalization") {
            await release();
          }
          expect(
            await withTestTimeout(
              checkpoint.promise,
              15_000,
              "Exec did not reach its ledger boundary",
            ),
            "main loop checkpoint must precede native writer release",
          ).toBe(0);
          if (phase === "creation") {
            expect(executionSettled).toBe(false);
            await release();
          }
          expect(
            await withTestTimeout(run.wait(), 15_000, "Released command did not exit"),
          ).toMatchObject({
            exitCode: 0,
          });
          await nextTurn();
          expect(Atomics.load(holder!.released, 0)).toBe(0);
          expect(scopeSettled, "native exit must not release the pending ledger write").toBe(false);
          expect(publications).toEqual(phase === "creation" ? [] : ["running"]);
          holder!.release();
          expect(await holder!.joined).toBe(0);
          await execution;
          await scope;
          expect(publications).toEqual(["running", "succeeded"]);
          const rows = listTasksForOwnerKey(sessionKey);
          expect(rows).toHaveLength(1);
          expect(
            loadTaskRegistryStateFromSqliteReadOnly().tasks.get(rows[0]!.taskId),
          ).toMatchObject({
            status: "succeeded",
            task: command,
            terminalSummary: "Command completed",
            detail: { exitCode: 0 },
          });
        } finally {
          try {
            holder?.release();
            await release();
            await Promise.allSettled([holder?.joined, execution, scope]);
            await waitForExecScope(sessionKey);
          } finally {
            clearImmediate(heartbeat);
            stop();
            observeSpawn.mockRestore();
            observeFinalization.mockRestore();
            observeCreation.mockRestore();
            resetTaskRegistryForTests({ persist: false });
          }
        }
      },
    );
  },
);
