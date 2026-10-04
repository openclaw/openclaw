import { expect, it, vi, type Mock } from "vitest";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import * as sessionStateEvents from "../../../sessions/session-state-events.js";
import {
  cleanupSessionStateTestState,
  createDatabaseOptions,
} from "../../../sessions/session-state-events.test-support.js";
import type { LifecycleControllerFixtureOptions } from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry.store.sqlite.js";
import type { SubagentCompletionRequest, SubagentRunRecord } from "./subagent-registry.types.js";

export function registerTerminalStateSignalAuthorityTests({
  createRunEntry,
  createLifecycleController,
  completeRun,
  helperMocks,
  lifecycleEventMocks,
}: {
  createRunEntry: (overrides?: Partial<SubagentRunRecord>) => SubagentRunRecord;
  createLifecycleController: (
    options: LifecycleControllerFixtureOptions,
  ) => SubagentLifecycleController;
  completeRun: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options?: Pick<SubagentCompletionRequest, "sessionEffects">,
  ) => Promise<void>;
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
  lifecycleEventMocks: { emitSessionLifecycleEvent: Mock };
}) {
  it.each([
    { change: "none", stage: "commit" },
    { change: "provisional kill", stage: "transaction" },
    { change: "corrected outcome", stage: "commit" },
    { change: "newer session run", stage: "commit" },
    { change: "retired session", stage: "transaction" },
    { change: "retired session", stage: "commit" },
  ] as const)(
    "commits terminal row and signal together after $change at worker $stage admission",
    async ({ change, stage }) => {
      createDatabaseOptions();
      let restoreAdmission: (() => void) | undefined;
      let controller: SubagentLifecycleController | undefined;
      try {
        const entry = createRunEntry();
        const runs = new Map<string, SubagentRunRecord>();
        await mutateSubagentRuns(
          [entry.runId],
          () => ({
            value: undefined,
            postimages: new Map([[entry.runId, entry]]),
          }),
          { runs },
        );
        let sessionCurrent = true;
        controller = createLifecycleController({ entry, runs, realWorker: true });
        let observed = false;
        let successorWrite: Promise<void> | undefined;
        const serializedSuccessor = change === "provisional kill" || change === "corrected outcome";
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const observe = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (!observed && request.stage === stage) {
                observed = true;
                if (serializedSuccessor) {
                  successorWrite = mutateSubagentRuns(
                    [entry.runId],
                    (rows) => {
                      const current = rows.get(entry.runId);
                      if (!current) {
                        throw new Error("Terminal fixture lost admitted run");
                      }
                      const draft = structuredClone(current);
                      if (change === "provisional kill") {
                        draft.killReconciliation = { killedAt: 4_001 };
                      } else {
                        draft.execution = {
                          ...draft.execution,
                          outcome: { status: "error", error: "corrected outcome" },
                        };
                      }
                      return { value: undefined, postimages: new Map([[draft.runId, draft]]) };
                    },
                    { runs },
                  );
                  void successorWrite.catch(() => {});
                } else if (change === "newer session run") {
                  const successor = createRunEntry({
                    runId: "successor",
                    generation: 2,
                    createdAt: 5_000,
                  });
                  runs.set(successor.runId, successor);
                } else if (change === "retired session") {
                  sessionCurrent = false;
                }
              }
              admit(request, grant);
            }, attachment),
          );
        restoreAdmission = () => observe.mockRestore();
        const assertSessionCurrent = () => {
          if (!sessionCurrent) {
            throw new Error("Session retired");
          }
        };
        const completion = completeRun(controller, entry, {
          sessionEffects: {
            isCurrent: async () => sessionCurrent,
            assertHostCurrent: assertSessionCurrent,
            assertCurrentEntry: assertSessionCurrent,
          },
        });
        if (change === "none" || serializedSuccessor) {
          await completion;
          await successorWrite;
          if (change === "none") {
            await completeRun(controller, entry);
          }
        } else {
          await expect(completion).rejects.toMatchObject({ outcome: "not-committed" });
        }
        expect(observed).toBe(true);
        const events = (
          await sessionStateEvents.listSessionStateEventsSince(
            entry.childSessionKey,
            "main",
            0,
            200,
          )
        ).events;
        const stored = loadSubagentRegistryFromSqlite().get(entry.runId);
        if (change === "none" || serializedSuccessor) {
          expect(events).toMatchObject([{ kind: "run_completed", runId: entry.runId }]);
          expect(stored?.execution.status).toBe("terminal");
          if (change === "corrected outcome") {
            expect(stored?.execution.outcome).toMatchObject({
              status: "error",
              error: "corrected outcome",
            });
          } else {
            expect(stored?.execution.outcome).toMatchObject({ status: "ok" });
          }
          if (change === "provisional kill") {
            expect(stored?.killReconciliation).toEqual({ killedAt: 4_001 });
          }
          if (change === "none") {
            expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledTimes(2);
          }
        } else {
          expect(events).toEqual([]);
          expect(stored?.execution.status).toBe("running");
          expect(runs.get(entry.runId)?.execution.status).toBe("running");
          expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
          expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
        }
      } finally {
        restoreAdmission?.();
        controller?.clearScheduledResumeTimers();
        await cleanupSessionStateTestState();
      }
    },
  );
}
