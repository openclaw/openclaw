import { expect, it, type Mock } from "vitest";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { writeSessionEntry } from "../../../config/sessions/session-accessor.sqlite-entry-store.js";
import { captureSessionEntryCurrentRead } from "../../../config/sessions/session-entry-current-runtime.js";
import type { SessionEntryCurrentCheck } from "../../../config/sessions/session-entry-current.types.js";
import { withSessionEntryReadOnlyInWorker } from "../../../config/sessions/session-entry-read-runtime.js";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../../infra/sqlite-worker-owner-probe.test-support.js";
import * as sessionStateEvents from "../../../sessions/session-state-events.js";
import {
  cleanupSessionStateTestState,
  createDatabaseOptions,
} from "../../../sessions/session-state-events.test-support.js";
import { openOpenClawAgentDatabase } from "../../../state/openclaw-agent-db.js";
import type { LifecycleControllerFixtureOptions } from "./subagent-registry-lifecycle-controller.test-support.js";
import type { SubagentLifecycleController } from "./subagent-registry-lifecycle.js";
import { mutateSubagentRuns } from "./subagent-registry-persistence.js";
import { loadSubagentRegistryFromSqlite } from "./subagent-registry-state.fixture.test-support.js";
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
    { change: "native metadata", stage: "transaction" },
    { change: "native ownership", stage: "transaction" },
  ] as const)(
    "commits terminal row and signal together after $change at worker $stage admission",
    async ({ change, stage }) => {
      const database = createDatabaseOptions();
      let restoreAdmission: (() => void) | undefined;
      let controller: SubagentLifecycleController | undefined;
      try {
        const entry = createRunEntry();
        let nativeCheck: SessionEntryCurrentCheck | undefined;
        let changeNativeEntry: (() => void) | undefined;
        if (change === "native metadata" || change === "native ownership") {
          const target = { agentId: "main", sessionKey: entry.childSessionKey, env: database.env };
          const sessionEntry = {
            sessionId: "session-id",
            lifecycleRevision: "session-revision",
            lifecycleRunId: "original-run",
            updatedAt: 1,
          };
          await upsertSessionEntryCore(target, sessionEntry);
          const current = await withSessionEntryReadOnlyInWorker(
            target,
            () => {},
            async (read, owner) => {
              if (!read.ok) {
                throw read.error;
              }
              return captureSessionEntryCurrentRead(target, owner);
            },
          );
          if (!current.source) {
            throw new Error("Terminal fixture requires a durable child source");
          }
          const writer = openOpenClawAgentDatabase({
            agentId: "main",
            path: current.source.path,
            env: database.env,
          });
          changeNativeEntry = () => {
            writeSessionEntry(writer, entry.childSessionKey, {
              ...sessionEntry,
              ...(change === "native ownership"
                ? { lifecycleRunId: "successor-run" }
                : { completionOwnerSessionKey: "agent:main:changed-parent" }),
            });
          };
          nativeCheck = {
            source: current.source,
            assertCurrent(facts) {
              current.assertSourceCurrent();
              if (facts?.lifecycleRunId !== sessionEntry.lifecycleRunId) {
                throw new Error("Terminal child source was replaced");
              }
            },
          };
        }
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
        const commits = change === "none" || serializedSuccessor || change === "native metadata";
        const observe = probe.admission(workerAdmission, (request, grant, admit) => {
          if (!observed && request.stage === stage) {
            observed = true;
            changeNativeEntry?.();
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
        });
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
            nativeCheck,
          },
        });
        if (commits) {
          await completion;
          await successorWrite;
          if (change === "none") {
            const admissions = observe.mock.calls.length;
            await completeRun(controller, entry);
            expect(observe.mock.calls).toHaveLength(admissions);
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
        if (commits) {
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
            expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
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
