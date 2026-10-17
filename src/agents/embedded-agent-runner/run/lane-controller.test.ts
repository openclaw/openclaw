import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { clearRuntimeConfigSnapshot } from "../../../config/runtime-snapshot.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createLaneControllerFixture } from "./lane-controller.test-support.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneTestParams = RunEmbeddedAgentParams & { sessionFile: string };
type LaneFixtureOptions = Partial<LaneTestParams> & { sessionLane?: string; globalLane?: string };

function createLaneController(runId: string, params: LaneFixtureOptions = {}) {
  const runParams: LaneTestParams = {
    sessionId: runId,
    sessionFile: `${runId}.jsonl`,
    workspaceDir: "/tmp/openclaw-lane-controller-test",
    prompt: "test",
    timeoutMs: 1,
    runId,
    trigger: "user",
    ...params,
  };
  const sessionLane = params.sessionLane ?? `test:session:${runId}`;
  const globalLane = params.globalLane ?? `test:global:${runId}`;
  const { controller } = createLaneControllerFixture(runParams, { sessionLane, globalLane });
  return { ...controller, sessionLane, globalLane };
}

const runSession = <T>(
  controller: Pick<ReturnType<typeof createLaneController>, "enqueueSession">,
  task: () => Promise<T>,
) => controller.enqueueSession(task, { taskTimeoutMs: 25 });
const result = (durationMs = 1) => ({ meta: { durationMs } });
const neverSettles = async () => await new Promise<never>(() => {});
const expectTimeout = (task: Promise<unknown>) =>
  expect(task).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });

async function expectLaneCounts(lane: string, activeCount = 0, queuedCount = 0) {
  for (let turn = 0; turn < 20; turn += 1) {
    const snapshot = getCommandLaneSnapshot(lane);
    if (snapshot.activeCount === activeCount && snapshot.queuedCount === queuedCount) {
      break;
    }
    await delay(0);
  }
  expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount, queuedCount });
}

describe("embedded run session lane", () => {
  afterEach(() => {
    clearRuntimeConfigSnapshot();
    resetCommandQueueStateForTest();
  });

  it.each([
    ["enqueueSession", "synchronous"],
    ["enqueueSession", "asynchronous"],
    ["enqueueGlobal", "synchronous"],
    ["enqueueGlobal", "asynchronous"],
  ] as const)("passes run identity through %s with %s refusal", async (enqueueMethod, refusal) => {
    for (const trigger of ["user", "cron"] as const) {
      let observedOptions: Parameters<CommandQueueEnqueueFn>[1];
      const refused = new Error("queue admission refused");
      const controller = createLaneController("child-run", {
        trigger,
        sessionKey: "agent:example:subagent:child",
        spawnedBy: "agent:example:main",
        enqueue: (_task, options) => {
          observedOptions = options;
          if (refusal === "asynchronous") {
            return Promise.reject(refused);
          }
          throw refused;
        },
      });

      await expect(controller[enqueueMethod](async () => result())).rejects.toBe(refused);
      expect(observedOptions?.taskIdentity).toEqual({
        taskKind: trigger === "cron" ? "cron" : "spawn",
        sessionKey: "agent:example:subagent:child",
        runId: "child-run",
        requesterSessionKey: "agent:example:main",
      });
    }
  });

  it.each(["deadline", "release"] as const)(
    "releases all queued session turns when the active turn reaches its %s",
    async (termination) => {
      const sessionLane = `test:session-stall-${termination}`;
      setCommandLaneConcurrency(sessionLane, 1);
      const stalled = createLaneController(`stalled-${termination}`, { sessionLane });
      const stalledFailure = expectTimeout(runSession(stalled, neverSettles));
      const successorController = createLaneController(`successor-${termination}`, { sessionLane });
      const successor = successorController.enqueueSession(async () => "finished");

      await expectLaneCounts(sessionLane, 1, 1);

      if (termination === "release") {
        stalled.laneTaskReleaseController.abort();
      }

      await stalledFailure;
      await expect(successor).resolves.toBe("finished");
      await expectLaneCounts(sessionLane, 0, 0);
    },
  );

  it("prevents timed-out session work from resuming into global admission", async () => {
    const { sessionLane, globalLane, ...controller } = createLaneController("late-resumption");
    const maintenanceGate = createDeferred();
    const lateTaskSettled = createDeferred();
    const globalTask = vi.fn(async () => result());

    const timedOut = runSession(controller, async () => {
      try {
        await maintenanceGate.promise;
        controller.throwIfAborted();
        return await controller.enqueueGlobal(globalTask);
      } finally {
        lateTaskSettled.resolve();
      }
    });

    await expectTimeout(timedOut);
    expect(controller.abortSignal.aborted).toBe(true);

    maintenanceGate.resolve();
    await lateTaskSettled.promise;
    expect(globalTask).not.toHaveBeenCalled();
    await expectLaneCounts(sessionLane);
    await expectLaneCounts(globalLane);
  });

  it("keeps the session lease alive until every concurrent global admission settles", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { sessionLane, globalLane, ...controller } = createLaneController("concurrent-global");
      setCommandLaneConcurrency(globalLane, 1);

      const interveningGlobalGate = createDeferred();
      const interveningGlobalTaskStarted = createDeferred();
      // Load placement facts before the queue-heartbeat budget starts.
      await controller.enqueueGlobal(async () => result(0));
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const run = runSession(
          controller,
          async () =>
            await Promise.all([
              controller.enqueueGlobal(async () => result()),
              enqueueCommandInLane(
                globalLane,
                async () => {
                  interveningGlobalTaskStarted.resolve();
                  await interveningGlobalGate.promise;
                },
                { priority: "foreground" },
              ),
              controller.enqueueGlobal(async () => result(2)),
            ]),
        );
        await interveningGlobalTaskStarted.promise;
        await vi.advanceTimersByTimeAsync(75);
        await expectLaneCounts(sessionLane, 1, 0);
        await expectLaneCounts(globalLane, 1, 1);

        interveningGlobalGate.resolve();
        const expected = [{ meta: { durationMs: 1 } }, undefined, { meta: { durationMs: 2 } }];
        await expect(run).resolves.toEqual(expected);
        await expectLaneCounts(sessionLane, 0, 0);
      } finally {
        interveningGlobalGate.resolve();
        vi.useRealTimers();
      }
    });
  });

  it("keeps a session alive while another run's stalled global task times out", async () => {
    const { sessionLane, globalLane, ...controller } = createLaneController("global-successor");
    setCommandLaneConcurrency(globalLane, 1);

    const stalledGlobalTaskStarted = createDeferred();
    const stalledController = createLaneController("stalled-global-owner", {
      globalLane,
    });
    const run = runSession(controller, async () => {
      const stalledGlobalAdmission = stalledController.enqueueGlobal(
        async () => {
          stalledGlobalTaskStarted.resolve();
          return await neverSettles();
        },
        { taskTimeoutMs: 25 },
      );
      const stalledGlobalFailure = expectTimeout(stalledGlobalAdmission);
      const successorGlobalAdmission = controller.enqueueGlobal(async () => result());

      await stalledGlobalFailure;
      return await successorGlobalAdmission;
    });
    const completedRun = expect(run).resolves.toEqual({ meta: { durationMs: 1 } });

    await stalledGlobalTaskStarted.promise;
    await expectLaneCounts(sessionLane, 1, 0);
    await expectLaneCounts(globalLane, 1, 1);

    await completedRun;
    expect(stalledController.abortSignal.aborted).toBe(true);
    expect(controller.abortSignal.aborted).toBe(false);
    await expectLaneCounts(sessionLane);
    await expectLaneCounts(globalLane);
  });
});
