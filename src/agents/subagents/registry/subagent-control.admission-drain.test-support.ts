import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  beginSessionWorkAdmission,
  getActiveSessionLifecycleMutationCount,
  SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-lifecycle-admission.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { enqueueSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import type { registerLateDescendantControlTests } from "./subagent-control.late-registration.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
} from "./subagent-registry.test-helpers.js";

export function registerAdmissionDrainControlTests({
  cfgWithSessionStore,
  controllerFor,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
}: Parameters<typeof registerLateDescendantControlTests>[0] & {
  controllerFor: (
    controllerSessionKey: string,
  ) => Parameters<typeof killAllControlledSubagentRuns>[0]["controller"];
}) {
  it.each([false, true])(
    "releases queued=%s work when interrupted admission does not drain",
    async (queued) => {
      const controllerSessionKey = "agent:main:main";
      const childSessionKey = "agent:main:subagent:kill-admission-timeout";
      const sessionId = "sess-kill-admission-timeout";
      let entry = createSubagentRunRecord({
        runId: "run-kill-admission-timeout",
        childSessionKey,
        controllerSessionKey,
        requesterSessionKey: controllerSessionKey,
        task: "hold admission during kill",
        createdAt: Date.now() - 2_000,
        collect: queued,
        execution: queued
          ? { status: "queued" }
          : { status: "running", startedAt: Date.now() - 1_000 },
      });
      await addSubagentRunForTests(entry);
      entry = subagentRuns.get(entry.runId)!;
      const storePath = await writeSessionStoreFixture("kill-admission-timeout", {
        [childSessionKey]: { sessionId, updatedAt: Date.now() },
      });
      const interrupted = createDeferred();
      const admission = await beginSessionWorkAdmission({
        scope: storePath,
        identities: [childSessionKey, sessionId],
        assertAllowed: () => {},
        onInterrupt: () => interrupted.resolve(),
      });
      setSubagentControlDepsForTest({
        isEmbeddedAgentRunActive: () => false,
        abortEmbeddedAgentRun: () => false,
        clearSessionLifecycleQueues: () => ({ followupCleared: 0, laneCleared: 0, keys: [] }),
      });

      const dispatch = vi.fn(async () => {});
      if (queued) {
        enqueueSwarmRun({
          groupId: "drain",
          runId: entry.runId,
          maxConcurrent: 1,
          activeRunIds: ["holder"],
          start: dispatch,
          onStartFailure: () => true,
        });
      }
      vi.useFakeTimers();
      const pendingKill = killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(controllerSessionKey),
        runs: [entry],
      });
      try {
        await Promise.race([
          interrupted.promise,
          pendingKill.then(() => {
            throw new Error("Cancellation settled before interrupting the held admission");
          }),
        ]);
        expect(getActiveSessionLifecycleMutationCount()).toBeGreaterThan(0);
        if (queued) {
          releaseSwarmRun("holder");
        }
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SESSION_WORK_ADMISSION_DRAIN_TIMEOUT_MS);

        await expect(pendingKill).resolves.toMatchObject({
          status: "error",
          error:
            "hold admission during kill: Subagent is still active; try the kill again in a moment.",
        });
        expect(
          (await getSubagentRunByChildSessionKey(childSessionKey))?.execution.endedAt,
        ).toBeUndefined();
        expect(
          (await getSubagentRunByChildSessionKey(childSessionKey))?.killIntent,
        ).toBeUndefined();
        if (queued) {
          await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        }
      } finally {
        admission.release();
        swarmSchedulerTesting.reset();
        vi.useRealTimers();
        await pendingKill;
      }
    },
  );
}
