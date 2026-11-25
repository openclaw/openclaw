import { expect, it, onTestFinished, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../../test/helpers/promise.js";
import { replaceSessionEntrySync } from "../../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  beginSessionEffect,
  captureSessionTarget,
  SESSION_CONTROLLER_DRAIN_TIMEOUT_MS,
} from "../../../sessions/session-controller.lifecycle.js";
import { createReplyOperation } from "../../../sessions/session-controller.operation.js";
import { runOpenClawStateWorkerOperation } from "../../../state/openclaw-state-worker-store.js";
import { createSubagentRunRecord } from "../../subagent-test-fixtures.test-helpers.js";
import { holdQueuedSwarmRun, releaseSwarmRun } from "../swarm/swarm-scheduler.js";
import * as killSession from "./subagent-control-session.js";
import { controlController, enqueueControlRun } from "./subagent-control.fixtures.test-support.js";
import { killAllControlledSubagentRuns } from "./subagent-control.js";
import { runSubagentStateWorkerOperation } from "./subagent-control.test-support.js";
import { SUBAGENT_ENDED_REASON_KILLED } from "./subagent-lifecycle-events.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { markSubagentRunTerminated, registerSubagentRun } from "./subagent-registry.js";
import {
  addSubagentRunForTests,
  getSubagentRunByChildSessionKey as getChildRun,
} from "./subagent-registry.test-helpers.js";

type StoreControlDeps = {
  cfgWithSessionStore: (storePath: string) => OpenClawConfig;
  setSubagentControlDepsForTest: (
    overrides: Partial<typeof import("./subagent-control.runtime.js")>,
  ) => void;
  writeSessionStoreFixture: (label: string, store: Record<string, unknown>) => Promise<string>;
};

export function registerAdmissionDrainControlTests({
  cfgWithSessionStore,
  controllerFor,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
}: StoreControlDeps & {
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
        clearSessionQueues: () => [],
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
        const retained = await getChildRun(childSessionKey);
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

export function registerLateDescendantControlTests({
  cfgWithSessionStore,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
}: StoreControlDeps) {
  it.each([
    ["session preparation", false],
    ["parent persistence", false],
    ["admission drain", false],
    ["parent persistence", true],
  ] as const)(
    "captures descendants registered during %s before releasing capacity (replacement=%s)",
    async (phase, replaceChild) => {
      const owner = controlController.controllerSessionKey;
      let parent = createSubagentRunRecord({
        runId: "late-parent",
        childSessionKey: "agent:main:subagent:late-parent",
        childSessionIdentity: {
          sessionId: "late-parent-session",
          lifecycleRevision: "late-parent-session-revision",
        },
        requesterSessionKey: owner,
        requesterDisplayKey: owner,
        task: "orchestrator",
        cleanup: "keep",
        createdAt: 1,
        startedAt: 2,
      });
      let activeChild = createSubagentRunRecord({
        ...parent,
        runId: "live-child",
        childSessionKey: "agent:main:subagent:live-child",
        childSessionIdentity: {
          sessionId: "live-child-session",
          lifecycleRevision: "live-child-session-revision",
        },
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
      const childKey = "agent:main:subagent:late-child";
      const registerChild = () => {
        const requester = phase === "admission drain" ? activeChild : parent;
        expect(requester.execution.endedAt).toBeUndefined();
        enqueueControlRun("late-descendants", "late-child", [parent.runId], start);
        return registerSubagentRun({
          runId: "late-child",
          childSessionKey: childKey,
          childAgentId: "main",
          sessionEntry: {
            sessionId: "late-child-session",
            lifecycleRevision: "late-child-session-revision",
          },
          requesterSessionKey: requester.childSessionKey,
          requesterAgentId: "main",
          requesterDisplayKey: requester.childSessionKey,
          task: "registered while orchestrator is live",
          cleanup: "keep",
          collect: true,
          queued: true,
        });
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
            reached.resolve();
            await proceed.promise;
            return prepareSession(...args);
          },
        );
      }
      const reservationReleases: Promise<void>[] = [];
      const pending = killAllControlledSubagentRuns({
        cfg,
        controller: controlController,
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
        await registerSubagentRun({
          runId: "other-turn-root",
          childSessionKey: "agent:main:subagent:other-turn-root",
          childAgentId: "main",
          sessionEntry: {
            sessionId: "other-turn-root-session",
            lifecycleRevision: "other-turn-root-session-revision",
          },
          requesterSessionKey: owner,
          requesterAgentId: "main",
          requesterTurnRunId: "other-turn",
          requesterDisplayKey: owner,
          task: "outside the captured root set",
          cleanup: "keep",
          collect: true,
          queued: true,
        });
        enqueueControlRun("other-turn", "other-turn-root", [], outsideStart);
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
          expect((await getChildRun(childKey))?.execution.endedAt).toBeUndefined();
        } else {
          expect(
            start,
            "late descendant must be held before the capacity-releasing signal",
          ).not.toHaveBeenCalled();
          expect(await getChildRun(childKey)).toMatchObject({
            endedReason: SUBAGENT_ENDED_REASON_KILLED,
            execution: { status: "terminal" },
          });
        }
        expect(
          outsideStart,
          "discovery cannot add another root or inhibit its lane",
        ).toHaveBeenCalledOnce();
        expect(
          (await getChildRun("agent:main:subagent:other-turn-root"))?.execution.endedAt,
        ).toBeUndefined();
      } finally {
        proceed.resolve();
        admission.release();
        try {
          await pending;
        } finally {
          await Promise.all(reservationReleases);
        }
      }
    },
  );
}

export function registerQueuedReservationFailureTests({
  cfgWithSessionStore,
  setSubagentControlDepsForTest,
  writeSessionStoreFixture,
  resetRegistryLeafMocks,
}: StoreControlDeps & {
  resetRegistryLeafMocks: () => void;
}) {
  it.each([
    "tombstone write",
    "claim release",
    "session replacement at intent",
    "session replacement release",
    "session replacement",
    "row replacement",
    "lifecycle rotation",
    "parent persistence",
  ])("releases or withdraws the exact queued reservation after %s failure", async (failure) => {
    const { controllerSessionKey } = controlController;
    let entry = createSubagentRunRecord({
      runId: "failure-queued",
      childSessionKey: "agent:main:subagent:failure-queued",
      childSessionIdentity: {
        sessionId: "queued-session",
        lifecycleRevision: "queued-session-revision",
      },
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
    const reserve = () => enqueueControlRun("failure-lane", entry.runId, [], dispatch);
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
                  ["tombstone write", "claim release", "session replacement release"].includes(
                    failure,
                  ) &&
                  writeNumber === 2
                ) {
                  rejectedWrite = writeNumber;
                  throw new Error("sqlite busy");
                }
              }
              const receipt = await scope.execute(command);
              if (
                ["session replacement", "session replacement release"].includes(failure) &&
                writeNumber === 1
              ) {
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
      clearSessionQueues: () => [],
    });
    if (failure === "claim release") {
      const operation = createReplyOperation({
        sessionKey: entry.childSessionKey,
        sessionId: "queued-session",
        agentId: "main",
        resetTriggered: false,
        target: captureSessionTarget({
          storeScope: storePath,
          sessionKey: entry.childSessionKey,
          incarnation: "queued-session",
          agentId: "main",
        }),
      });
      operation.freezeAbort();
      onTestFinished(() => operation.complete());
    }
    const reservationReleases: Promise<void>[] = [];
    try {
      const pending = killAllControlledSubagentRuns({
        cfg: cfgWithSessionStore(storePath),
        controller: controlController,
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
        enqueueControlRun("failure-lane", "survivor", [], survivor);
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
        expect((await getChildRun(entry.childSessionKey))?.execution.endedAt).toBeUndefined();
      }
    } finally {
      await Promise.all(reservationReleases);
    }
  });
}
