import { expect, it, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import {
  beginSessionEffect,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-controller.lifecycle.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import { enqueueControlRun } from "./subagent-control.fixtures.test-support.js";
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
        childSessionIdentity: { sessionId, lifecycleRevision: sessionId + "-revision" },
        controllerSessionKey,
        task: "hold admission during kill",
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
      const admission = await beginSessionEffect({
        scope: storePath,
        identities: [childSessionKey, sessionId],
        assertAllowed: () => {},
        onInterrupt: () => interrupted.resolve(),
      });
      setSubagentControlDepsForTest({
        clearSessionQueues: () => ({ followupCleared: 0, keys: [] }),
      });

      const dispatch = vi.fn(async () => {});
      if (queued) {
        enqueueControlRun("drain", entry.runId, ["holder"], dispatch);
      }
      vi.useFakeTimers();
      const pendingKill = killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controllerFor(controllerSessionKey),
        runs: [entry],
      });
      const settled = vi.fn();
      void pendingKill.then(settled, settled);
      try {
        await awaitGateBeforeSettlement(
          interrupted.promise,
          pendingKill,
          "Cancellation settled before interrupting the held admission",
        );
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();
        if (queued) {
          releaseSwarmRun("holder");
        }
        await Promise.resolve();
        expect(dispatch).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(SESSION_CONTROLLER_DRAIN_TIMEOUT_MS);

        await expect(pendingKill).resolves.toMatchObject({
          status: "error",
          error:
            "hold admission during kill: Subagent is still active; try the kill again in a moment.",
        });
        const retained = await getSubagentRunByChildSessionKey(childSessionKey);
        expect(retained?.execution.endedAt).toBeUndefined();
        expect(retained?.killIntent).toBeUndefined();
        if (queued) {
          await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce());
        }
      } finally {
        admission.release();
        vi.useRealTimers();
        await pendingKill;
      }
    },
  );
}
