import { expect, it, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import type { registerLateDescendantControlTests } from "./subagent-control.late-registration.test-support.js";
import { runSubagentStateWorkerOperation } from "./subagent-control.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated } from "./subagent-registry.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
} from "./subagent-registry.test-helpers.js";

export function registerQueuedReservationFailureTests({
  cfgWithSessionStore,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
  resetRegistryLeafMocks,
}: Parameters<typeof registerLateDescendantControlTests>[0] & {
  resetRegistryLeafMocks: () => void;
}) {
  it.each([
    "intent write",
    "tombstone write",
    "claim release",
    "session replacement at intent",
    "session replacement release",
    "abort refusal",
    "session replacement",
    "row replacement",
    "lifecycle rotation",
    "parent persistence",
  ])("releases or withdraws the exact queued reservation after %s failure", async (failure) => {
    const controllerSessionKey = "agent:main:main";
    let entry = createSubagentRunRecord({
      runId: "failure-queued",
      childSessionKey: "agent:main:subagent:failure-queued",
      controllerSessionKey,
      requesterSessionKey: controllerSessionKey,
      task: "queued failure",
      createdAt: 1,
      generation: 1,
      collect: true,
      swarmLaunchPending: true,
      execution: { status: "queued" },
    });
    await addSubagentRunForTests(entry);
    entry = subagentRuns.get(entry.runId)!;
    const storePath = await writeSessionStoreFixture("queue-failure", {
      [entry.childSessionKey]: { sessionId: "queued-session", updatedAt: 1 },
    });
    const dispatch = vi.fn(async () => {});
    const reserve = () =>
      enqueueSwarmRun({
        groupId: "failure-lane",
        runId: entry.runId,
        maxConcurrent: 1,
        activeRunIds: [],
        start: dispatch,
        onStartFailure: () => true,
      });
    reserve();
    let writes = 0;
    let rejectedWrite: number | undefined;
    resetRegistryLeafMocks();
    vi.mocked(runOpenClawStateWorkerOperation).mockImplementation((context, operation, options) =>
      runSubagentStateWorkerOperation(
        context,
        (scope) =>
          operation({
            ...scope,
            execute: async (command) => {
              const writeNumber =
                command.type === "subagents.persistChanges" ? ++writes : undefined;
              if (writeNumber !== undefined) {
                if (failure === "session replacement at intent" && writeNumber === 1) {
                  replaceSessionEntrySync(
                    { storePath, sessionKey: entry.childSessionKey },
                    { sessionId: "new-session", updatedAt: 2 },
                  );
                }
                if (
                  (failure === "intent write" && writeNumber === 1) ||
                  (["tombstone write", "claim release", "session replacement release"].includes(
                    failure,
                  ) &&
                    writeNumber === 2)
                ) {
                  rejectedWrite = writeNumber;
                  throw new Error("sqlite busy");
                }
              }
              const receipt = await scope.execute(command);
              if (failure === "session replacement release" && writeNumber === 1) {
                replaceSessionEntrySync(
                  { storePath, sessionKey: entry.childSessionKey },
                  { sessionId: "new-session", updatedAt: 2 },
                );
              }
              return receipt;
            },
          }),
        options,
      ),
    );
    setSubagentControlDepsForTest({
      isEmbeddedAgentRunActive: () => {
        if (failure === "session replacement") {
          replaceSessionEntrySync(
            { storePath, sessionKey: entry.childSessionKey },
            { sessionId: "new-session", updatedAt: 2 },
          );
        }
        return ["abort refusal", "claim release"].includes(failure);
      },
      abortEmbeddedAgentRun: () => !["abort refusal", "claim release"].includes(failure),
      clearSessionLifecycleQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
    });
    const reservationReleases: Promise<void>[] = [];
    try {
      const pending = killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: {
          controllerSessionKey,
          controllerAgentId: "main",
          callerSessionKey: controllerSessionKey,
          callerIsSubagent: false,
          controlScope: "children",
        },
        runs: [entry],
        beforeKill: async () => {
          await Promise.resolve();
          expect(
            dispatch,
            "scheduled pump cannot dispatch while cancellation owns the reservation",
          ).not.toHaveBeenCalled();
          if (failure === "row replacement") {
            const hold = holdQueuedSwarmRun(entry.runId);
            const withdrawn = hold?.withdraw();
            if (hold) {
              reservationReleases.push(hold.release());
            }
            expect(withdrawn).toBe(true);
            await addSubagentRunForTests({ ...entry, generation: 2, createdAt: 2 });
            reserve();
          }
          if (failure === "lifecycle rotation") {
            rotateAgentEventLifecycleGeneration();
          }
          if (failure === "parent persistence") {
            throw new Error("partial persistence failed");
          }
          return true;
        },
      });
      if (failure === "parent persistence") {
        await expect(pending).rejects.toThrow("partial persistence failed");
      } else {
        const result = await pending;
        expect(result.killed).toBe(0);
        expect(result.status).toBe(
          ["row replacement", "lifecycle rotation"].includes(failure) ? "ok" : "error",
        );
        if (failure === "session replacement release") {
          expect(rejectedWrite).toBe(2);
          expect(result).toMatchObject({
            error: expect.stringContaining("kill intent could not be released"),
          });
        }
      }
      if (["tombstone write", "claim release", "session replacement release"].includes(failure)) {
        expect(subagentRuns.get(entry.runId)?.killIntent).toMatchObject({ reason: "killed" });
        const survivor = vi.fn(async () => {});
        enqueueSwarmRun({
          groupId: "failure-lane",
          runId: "survivor",
          maxConcurrent: 1,
          activeRunIds: [],
          start: survivor,
          onStartFailure: () => true,
        });
        await vi.waitFor(() => expect(survivor).toHaveBeenCalledOnce());
        expect(dispatch).not.toHaveBeenCalled();
        expect(await markSubagentRunTerminated({ runId: entry.runId })).toBe(1);
        expect(subagentRuns.get(entry.runId)?.collectorCompletion).toMatchObject({
          status: "killed",
        });
        expect(dispatch).not.toHaveBeenCalled();
      } else {
        expect(subagentRuns.get(entry.runId)?.killIntent).toBeUndefined();
        await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        expect(
          getSubagentRunByChildSessionKey(entry.childSessionKey)?.execution.endedAt,
        ).toBeUndefined();
      }
    } finally {
      await Promise.all(reservationReleases);
      swarmSchedulerTesting.reset();
    }
  });
}
