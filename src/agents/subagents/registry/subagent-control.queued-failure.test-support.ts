import { expect, it, onTestFinished, vi } from "vitest";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import { captureSessionTarget } from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import {
  controlController as controller,
  controlSessionKey as key,
  enqueueControlRun,
} from "./subagent-control.fixtures.test-support.js";
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
    ["tombstone write", undefined, true],
    ["claim release", undefined, true],
    ["session replacement at intent", "before", false],
    ["session replacement release", "after", true],
    ["session replacement", "after", false],
    ["row replacement", undefined, false],
    ["lifecycle rotation", undefined, false],
    ["parent persistence", undefined, false],
  ] as const)(
    "releases or withdraws the exact queued reservation after %s failure",
    async (failure, replaceAt, rejectSecondWrite) => {
      const childSessionKey = key("failure-queued");
      const sessionId = "queued-session";
      let entry = createSubagentRunRecord({
        runId: "failure-queued",
        childSessionKey,
        childSessionIdentity: { sessionId, lifecycleRevision: "queued-session-revision" },
        controllerSessionKey: controller.controllerSessionKey,
        createdAt: 1,
        generation: 1,
        collect: true,
        swarmLaunchPending: true,
        execution: { status: "queued" },
      });
      await addSubagentRunForTests(entry);
      entry = subagentRuns.get(entry.runId)!;
      const storePath = await writeSessionStoreFixture("queue-failure", {
        [childSessionKey]: { sessionId, updatedAt: 1 },
      });
      const dispatch = vi.fn(async () => {});
      const reserve = (runId = entry.runId, start = dispatch) =>
        enqueueControlRun("failure-lane", runId, [], start);
      reserve();
      let writes = 0;
      let rejectedWrite: number | undefined;
      const target = { storePath, sessionKey: childSessionKey };
      const replaceSession = () =>
        replaceSessionEntrySync(target, { sessionId: "new-session", updatedAt: 2 });
      resetRegistryLeafMocks();
      vi.mocked(runOpenClawStateWorkerOperation).mockImplementation((context, operation, options) =>
        runSubagentStateWorkerOperation(
          context,
          (scope) =>
            operation({
              ...scope,
              execute: async (command) => {
                if (command.type !== "subagents.persistChanges") {
                  return scope.execute(command);
                }
                const writeNumber = ++writes;
                if (replaceAt === "before" && writeNumber === 1) {
                  replaceSession();
                }
                if (rejectSecondWrite && writeNumber === 2) {
                  rejectedWrite = writeNumber;
                  throw new Error("sqlite busy");
                }
                const receipt = await scope.execute(command);
                if (replaceAt === "after" && writeNumber === 1) {
                  replaceSession();
                }
                return receipt;
              },
            }),
          options,
        ),
      );
      setSubagentControlDepsForTest({
        clearSessionQueues: () => ({ followupCleared: 0, keys: [] }),
      });
      if (failure === "claim release") {
        const identity = { sessionKey: childSessionKey, sessionId, agentId: "main" };
        const operation = createReplyOperation({
          ...identity,
          resetTriggered: false,
          target: captureSessionTarget({
            storeScope: storePath,
            ...identity,
            incarnation: sessionId,
          }),
        });
        operation.freezeAbort();
        onTestFinished(() => operation.complete());
      }
      const reservationReleases: Promise<void>[] = [];
      try {
        const pending = killAllControlledSubagentRuns({
          cfg: cfgWithSessionStore(storePath),
          controller,
          runs: [entry],
          beforeKill: async () => {
            await Promise.resolve();
            expect(dispatch).not.toHaveBeenCalled();
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
          expect(result).toMatchObject({
            killed: 0,
            status: ["row replacement", "lifecycle rotation"].includes(failure) ? "ok" : "error",
          });
          if (failure === "session replacement release") {
            expect(rejectedWrite).toBe(2);
            expect(result).toMatchObject({
              error: expect.stringContaining("kill intent could not be released"),
            });
          }
        }
        if (rejectSecondWrite) {
          expect(subagentRuns.get(entry.runId)?.killIntent).toMatchObject({ reason: "killed" });
          const survivor = vi.fn(async () => {});
          reserve("survivor", survivor);
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
            (await getSubagentRunByChildSessionKey(entry.childSessionKey))?.execution.endedAt,
          ).toBeUndefined();
        }
      } finally {
        await Promise.all(reservationReleases);
        swarmSchedulerTesting.reset();
      }
    },
  );
}
