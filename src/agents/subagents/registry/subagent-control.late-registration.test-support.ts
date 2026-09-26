import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { beginSessionWorkAdmission } from "../../../sessions/session-lifecycle-admission.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import {
  enqueueSwarmRun,
  releaseSwarmRun,
  removeQueuedSwarmRun,
} from "../swarm/swarm-scheduler.js";
import { testing as swarmSchedulerTesting } from "../swarm/swarm-scheduler.test-support.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
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
    ["runtime load", false],
    ["parent persistence", false],
    ["admission drain", false],
    ["parent persistence", true],
  ] as const)(
    "captures descendants registered during %s before releasing capacity (replacement=%s)",
    async (phase, replaceChild) => {
      const owner = "agent:main:main";
      const parent = createSubagentRunRecord({
        runId: "late-parent",
        childSessionKey: "agent:main:subagent:late-parent",
        requesterSessionKey: owner,
        requesterDisplayKey: owner,
        task: "orchestrator",
        cleanup: "keep",
        createdAt: 1,
        startedAt: 2,
      });
      const activeChild = createSubagentRunRecord({
        ...parent,
        runId: "live-child",
        childSessionKey: "agent:main:subagent:live-child",
        controllerSessionKey: parent.childSessionKey,
      });
      addSubagentRunForTests(parent);
      if (phase === "admission drain") {
        addSubagentRunForTests(activeChild);
      }
      const storePath = await writeSessionStoreFixture("late-descendant", {
        [parent.childSessionKey]: { sessionId: "late-parent-session", updatedAt: 1 },
      });
      const reached = createDeferred();
      const proceed = createDeferred();
      const admission = await beginSessionWorkAdmission({
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
      const childKey = "agent:main:subagent:late-child";
      const registerChild = () => {
        const requester = phase === "admission drain" ? activeChild : parent;
        expect(requester.execution.endedAt).toBeUndefined();
        enqueueSwarmRun({
          groupId: "late-descendants",
          runId: "late-child",
          activeRunIds: [parent.runId],
          maxConcurrent: 1,
          start,
          onStartFailure: () => true,
        });
        return registerSubagentRun({
          runId: "late-child",
          childSessionKey: childKey,
          requesterSessionKey: requester.childSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: requester.childSessionKey,
          task: "registered while orchestrator is live",
          cleanup: "keep",
          collect: true,
          queued: true,
        });
      };
      setSubagentControlDepsForTest({
        isEmbeddedAgentRunActive: () => true,
        abortEmbeddedAgentRun: () => {
          if (phase === "admission drain") {
            expect(releaseSwarmRun(parent.runId)).toBe(true);
          }
          return true;
        },
      });
      const controller = {
        controllerSessionKey: owner,
        controllerAgentId: "main",
        callerSessionKey: owner,
        callerIsSubagent: false,
        controlScope: "children" as const,
      };
      const cfg = cfgWithSessionStore(storePath);
      if (replaceChild) {
        const registration = registerChild();
        if (registration) {
          await registration;
        }
      }
      const pending = killAllControlledSubagentRuns({
        cfg,
        controller,
        runs: [parent],
        beforeKill:
          phase === "parent persistence"
            ? async () => {
                reached.resolve();
                await proceed.promise;
                return true;
              }
            : undefined,
      });
      try {
        if (phase !== "runtime load") {
          await reached.promise;
        }
        if (replaceChild) {
          expect(removeQueuedSwarmRun("late-child")).toBe(true);
        }
        const registration = registerChild();
        if (registration) {
          await registration;
        }
        const outsideStart = vi.fn(async () => {});
        const outsideRegistration = registerSubagentRun({
          runId: "other-turn-root",
          childSessionKey: "agent:main:subagent:other-turn-root",
          requesterSessionKey: owner,
          requesterAgentId: "main",
          requesterTurnRunId: "other-turn",
          requesterDisplayKey: owner,
          task: "outside the captured root set",
          cleanup: "keep",
          collect: true,
          queued: true,
        });
        if (outsideRegistration) {
          await outsideRegistration;
        }
        enqueueSwarmRun({
          groupId: "other-turn",
          runId: "other-turn-root",
          maxConcurrent: 1,
          activeRunIds: [],
          start: outsideStart,
          onStartFailure: () => true,
        });
        proceed.resolve();
        if (phase === "admission drain") {
          admission.release();
        }
        await pending;
        if (replaceChild) {
          expect(
            start,
            "discovery cannot adopt a selected child's replacement generation",
          ).toHaveBeenCalledOnce();
          expect(getSubagentRunByChildSessionKey(childKey)?.execution.endedAt).toBeUndefined();
        } else {
          expect(
            start,
            "late descendant must be held before the capacity-releasing signal",
          ).not.toHaveBeenCalled();
          expect(getSubagentRunByChildSessionKey(childKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
        expect(
          outsideStart,
          "discovery cannot add another root or inhibit its lane",
        ).toHaveBeenCalledOnce();
        expect(
          getSubagentRunByChildSessionKey("agent:main:subagent:other-turn-root")?.execution.endedAt,
        ).toBeUndefined();
      } finally {
        proceed.resolve();
        admission.release();
        await pending;
        swarmSchedulerTesting.reset();
      }
    },
  );
}
