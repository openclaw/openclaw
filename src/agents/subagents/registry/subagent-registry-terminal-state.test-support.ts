import { expect, it, vi, type Mock } from "vitest";
import * as workerAdmission from "../../../infra/sqlite-worker-operation-admission.js";
import * as sessionStateEvents from "../../../sessions/session-state-events.js";
import {
  cleanupSessionStateTestState,
  createDatabaseOptions,
} from "../../../sessions/session-state-events.test-support.js";
import * as terminalState from "../../../sessions/subagent-terminal-state.js";
import type {
  SubagentLifecycleController,
  SubagentLifecycleOptions,
} from "./subagent-registry-lifecycle.js";
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
    options: { entry: SubagentRunRecord } & Partial<SubagentLifecycleOptions>,
  ) => SubagentLifecycleController;
  completeRun: (
    controller: SubagentLifecycleController,
    entry: SubagentRunRecord,
    options?: Pick<SubagentCompletionRequest, "isChildSessionEffectsCurrent">,
  ) => Promise<void>;
  helperMocks: { persistSubagentSessionTiming: Mock<() => Promise<void>> };
  lifecycleEventMocks: { emitSessionLifecycleEvent: Mock };
}) {
  it.each([
    { change: "none", stage: "commit" },
    { change: "provisional kill", stage: "transaction" },
    { change: "corrected outcome", stage: "commit" },
    { change: "newer session run", stage: "commit" },
    { change: "retired session", stage: "commit" },
  ] as const)(
    "records only the current terminal outcome after $change at worker $stage admission",
    async ({ change, stage }) => {
      createDatabaseOptions();
      vi.mocked(terminalState.recordSubagentTerminalState).mockRestore();
      let restoreAdmission: (() => void) | undefined;
      try {
        expect(
          await sessionStateEvents.recordSessionStateEventAsync({
            sessionKey: "agent:main:warm-fixture",
            agentId: "main",
            kind: "compacted",
            actorType: "system",
            summary: "warm signal worker",
          }),
        ).toBeDefined();
        const entry = createRunEntry();
        const runs = new Map([[entry.runId, entry]]);
        let sessionCurrent = true;
        const retireSupersededRun = vi.fn(async () => {});
        const controller = createLifecycleController({ entry, runs, retireSupersededRun });
        let observed = false;
        const createAdmission = workerAdmission.createSqliteWorkerOperationAdmission;
        const observe = vi
          .spyOn(workerAdmission, "createSqliteWorkerOperationAdmission")
          .mockImplementation((admit, attachment) =>
            createAdmission((request, grant) => {
              if (!observed && request.stage === stage) {
                observed = true;
                if (change === "provisional kill") {
                  entry.killReconciliation = { killedAt: 4_001 };
                } else if (change === "corrected outcome") {
                  entry.execution.outcome = { status: "error", error: "corrected outcome" };
                } else if (change === "newer session run") {
                  const successor = createRunEntry({ runId: "successor", createdAt: 5_000 });
                  runs.set(successor.runId, successor);
                } else if (change === "retired session") {
                  sessionCurrent = false;
                }
              }
              admit(request, grant);
            }, attachment),
          );
        restoreAdmission = () => observe.mockRestore();
        await completeRun(controller, entry, {
          isChildSessionEffectsCurrent: () => sessionCurrent,
        });
        expect(observed).toBe(true);
        const events = sessionStateEvents.listSessionStateEventsSince(
          entry.childSessionKey,
          "main",
          0,
          200,
        ).events;
        if (change === "none") {
          expect(events).toMatchObject([{ kind: "run_completed", runId: entry.runId }]);
          expect(helperMocks.persistSubagentSessionTiming).toHaveBeenCalledOnce();
        } else {
          expect(events).toEqual([]);
          expect(helperMocks.persistSubagentSessionTiming).not.toHaveBeenCalled();
          expect(lifecycleEventMocks.emitSessionLifecycleEvent).not.toHaveBeenCalled();
        }
        expect(retireSupersededRun).toHaveBeenCalledTimes(change === "newer session run" ? 1 : 0);
      } finally {
        restoreAdmission?.();
        await cleanupSessionStateTestState();
      }
    },
  );
}
