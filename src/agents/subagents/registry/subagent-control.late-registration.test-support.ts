import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { beginSessionEffect } from "../../../sessions/session-controller.lifecycle.js";
import {
  createSubagentRunParams,
  createSubagentRunRecord,
} from "../../subagent-test-fixtures.test-helpers.js";
import { releaseSwarmRun, holdQueuedSwarmRun } from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import * as killSession from "./subagent-control-session.js";
import {
  controlController as controller,
  controlSessionKey as key,
  enqueueControlRun,
} from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { registerSubagentRun } from "./subagent-registry.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey,
} from "./subagent-registry.test-helpers.js";

export function registerLateDescendantControlTests({
  cfgWithSessionStore,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
}: {
  cfgWithSessionStore: (storePath: string) => OpenClawConfig;
  setSubagentControlDepsForTest: (
    overrides: Partial<typeof import("./subagent-control.runtime.js")>,
  ) => void;
  writeSessionStoreFixture: (label: string, store: Record<string, unknown>) => Promise<string>;
}) {
  it.each([
    ["session preparation", false],
    ["parent persistence", false],
    ["admission drain", false],
    ["parent persistence", true],
  ] as const)(
    "captures descendants registered during %s before releasing capacity (replacement=%s)",
    async (phase, replaceChild) => {
      const identity = (id: string) => ({
        sessionId: `${id}-session`,
        lifecycleRevision: `${id}-session-revision`,
      });
      const registerQueued = (
        runId: string,
        requesterSessionKey: string,
        requesterTurnRunId?: string,
      ) =>
        registerSubagentRun(
          createSubagentRunParams({
            runId,
            childSessionKey: key(runId),
            sessionEntry: identity(runId),
            requesterSessionKey,
            requesterAgentId: "main",
            requesterTurnRunId,
            requesterDisplayKey: requesterSessionKey,
            collect: true,
            queued: true,
          }),
        );
      let parent = createSubagentRunRecord({
        runId: "late-parent",
        childSessionKey: key("late-parent"),
        childSessionIdentity: identity("late-parent"),
        requesterDisplayKey: controller.controllerSessionKey,
        createdAt: 1,
        startedAt: 2,
      });
      let activeChild = createSubagentRunRecord({
        ...parent,
        runId: "live-child",
        childSessionKey: key("live-child"),
        childSessionIdentity: identity("live-child"),
        controllerSessionKey: parent.childSessionKey,
      });
      await addSubagentRunForTests(parent);
      parent = subagentRuns.get(parent.runId)!;
      if (phase === "admission drain") {
        await addSubagentRunForTests(activeChild);
        activeChild = subagentRuns.get(activeChild.runId)!;
      }
      const storePath = await writeSessionStoreFixture("late-descendant", {
        [parent.childSessionKey]: { sessionId: "late-parent-session", updatedAt: 1 },
      });
      const reached = createDeferred();
      const proceed = createDeferred();
      const pause = async () => {
        reached.resolve();
        await proceed.promise;
        return true;
      };
      const admission = await beginSessionEffect({
        scope: storePath,
        identities: [parent.childSessionKey, "late-parent-session"],
        assertAllowed: () => {},
        onInterrupt: () => {
          reached.resolve();
          if (phase !== "admission drain") {
            expect(releaseSwarmRun(parent.runId)).toBe(true);
            admission.release();
          }
        },
      });
      const start = vi.fn(async () => {});
      const childKey = key("late-child");
      const registerChild = () => {
        const requester = phase === "admission drain" ? activeChild : parent;
        expect(requester.execution.endedAt).toBeUndefined();
        enqueueControlRun("late-descendants", "late-child", [parent.runId], start);
        return registerQueued("late-child", requester.childSessionKey);
      };
      setSubagentControlDepsForTest({});
      const cfg = cfgWithSessionStore(storePath);
      if (replaceChild) {
        await registerChild();
      }
      if (phase === "session preparation") {
        const prepareSession = killSession.prepareSubagentKillSession;
        vi.spyOn(killSession, "prepareSubagentKillSession").mockImplementationOnce(
          async (...args) => {
            await pause();
            return prepareSession(...args);
          },
        );
      }
      const reservationReleases: Promise<void>[] = [];
      const pending = killAllControlledSubagentRuns({
        cfg,
        controller,
        runs: [parent],
        beforeKill: phase === "parent persistence" ? pause : undefined,
      });
      try {
        await reached.promise;
        if (replaceChild) {
          const hold = holdQueuedSwarmRun("late-child");
          const withdrawn = hold?.withdraw();
          if (hold) {
            reservationReleases.push(hold.release());
          }
          expect(withdrawn).toBe(true);
        }
        await registerChild();
        const outsideStart = vi.fn(async () => {});
        await registerQueued("other-turn-root", controller.controllerSessionKey, "other-turn");
        enqueueControlRun("other-turn", "other-turn-root", [], outsideStart);
        proceed.resolve();
        if (phase === "admission drain") {
          admission.release();
        }
        await pending;
        if (replaceChild) {
          expect(start).toHaveBeenCalledOnce();
          expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
            execution: { endedAt: undefined },
          });
        } else {
          expect(start).not.toHaveBeenCalled();
          expect(await getSubagentRunByChildSessionKey(childKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
        expect(outsideStart).toHaveBeenCalledOnce();
        expect(await getSubagentRunByChildSessionKey(key("other-turn-root"))).toMatchObject({
          execution: { endedAt: undefined },
        });
      } finally {
        proceed.resolve();
        admission.release();
        try {
          await pending;
        } finally {
          await Promise.all(reservationReleases);
          swarmSchedulerTesting.reset();
        }
      }
    },
  );
}
