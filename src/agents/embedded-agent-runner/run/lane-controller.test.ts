import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../../config/runtime-snapshot.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { withOpenClawTestState } from "../../../test-utils/openclaw-test-state.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneTestParams = RunEmbeddedAgentParams & { sessionFile: string };

function createLaneController(
  runId: string,
  params: {
    sessionLane?: string;
    globalLane?: string;
    enqueue?: CommandQueueEnqueueFn;
    runOverrides?: Partial<LaneTestParams>;
  } = {},
) {
  let runParams: LaneTestParams = {
    sessionId: runId,
    sessionFile: `${runId}.jsonl`,
    workspaceDir: "/tmp/openclaw-lane-controller-test",
    prompt: "test",
    timeoutMs: 1,
    runId,
    trigger: "user",
    ...params.runOverrides,
    ...(params.enqueue ? { enqueue: params.enqueue } : {}),
  };
  setRuntimeConfigSnapshot(runParams.config ?? {});
  let lifecycleGeneration = getAgentEventLifecycleGeneration();

  const sessionLane = params.sessionLane ?? `test:session:${runId}`;
  const globalLane = params.globalLane ?? `test:global:${runId}`;
  const controller = createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => runParams,
    globalLane,
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (nextParams) => {
      runParams = nextParams;
    },
  });
  return { controller, sessionLane, globalLane };
}

const result = (durationMs = 1) => ({ meta: { durationMs } });
const neverSettles = async () => await new Promise<never>(() => {});
const expectTimeout = (task: Promise<unknown>) =>
  expect(task).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });

async function expectEmptyLanes(...lanes: string[]) {
  for (const lane of lanes) {
    await expectLaneCounts(lane, 0, 0);
  }
}

async function expectLaneCounts(lane: string, activeCount: number, queuedCount: number) {
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
      const { controller } = createLaneController("child-run", {
        runOverrides: {
          trigger,
          sessionKey: "agent:example:subagent:child",
          spawnedBy: "agent:example:main",
        },
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
      const { controller: stalledController } = createLaneController(`stalled-${termination}`, {
        sessionLane,
      });
      const stalledFailure = expectTimeout(
        stalledController.enqueueSession(neverSettles, { taskTimeoutMs: 25 }),
      );
      const { controller: successorController } = createLaneController(`successor-${termination}`, {
        sessionLane,
      });
      const successor = successorController.enqueueSession(async () => "finished");

      await expectLaneCounts(sessionLane, 1, 1);

      if (termination === "release") {
        stalledController.laneTaskReleaseController.abort();
      }

      await stalledFailure;
      await expect(successor).resolves.toBe("finished");
      await expectLaneCounts(sessionLane, 0, 0);
    },
  );

  it("prevents timed-out session work from resuming into global admission", async () => {
    const { controller, sessionLane, globalLane } = createLaneController("late-resumption");
    const maintenanceGate = createDeferred();
    const lateTaskSettled = createDeferred();
    let enteredGlobalAdmission = false;

    const timedOut = controller.enqueueSession(
      async () => {
        try {
          await maintenanceGate.promise;
          controller.throwIfAborted();
          return await controller.enqueueGlobal(async () => {
            enteredGlobalAdmission = true;
            return result();
          });
        } finally {
          lateTaskSettled.resolve();
        }
      },
      { taskTimeoutMs: 25 },
    );

    await expectTimeout(timedOut);
    expect(controller.abortSignal.aborted).toBe(true);

    maintenanceGate.resolve();
    await lateTaskSettled.promise;
    expect(enteredGlobalAdmission).toBe(false);
    await expectEmptyLanes(sessionLane, globalLane);
  });

  it("keeps the session lease alive until every concurrent global admission settles", async () => {
    await withOpenClawTestState({ scenario: "minimal", prepareProfileCatalog: true }, async () => {
      const { controller, sessionLane, globalLane } = createLaneController("concurrent-global");
      setCommandLaneConcurrency(globalLane, 1);

      const interveningGlobalGate = createDeferred();
      const interveningGlobalTaskStarted = createDeferred();
      // Load placement facts before the queue-heartbeat budget starts.
      await controller.enqueueGlobal(async () => result(0));
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      try {
        const run = controller.enqueueSession(
          async () => {
            const firstGlobalAdmission = controller.enqueueGlobal(async () => result());
            const interveningGlobalTask = enqueueCommandInLane(
              globalLane,
              async () => {
                interveningGlobalTaskStarted.resolve();
                await interveningGlobalGate.promise;
              },
              { priority: "foreground" },
            );
            const secondGlobalAdmission = controller.enqueueGlobal(async () => result(2));
            return await Promise.all([
              firstGlobalAdmission,
              interveningGlobalTask,
              secondGlobalAdmission,
            ]);
          },
          { taskTimeoutMs: 25 },
        );
        await interveningGlobalTaskStarted.promise;
        await vi.advanceTimersByTimeAsync(75);
        await expectLaneCounts(sessionLane, 1, 0);
        await expectLaneCounts(globalLane, 1, 1);

        interveningGlobalGate.resolve();
        await expect(run).resolves.toEqual([
          { meta: { durationMs: 1 } },
          undefined,
          { meta: { durationMs: 2 } },
        ]);
        await expectLaneCounts(sessionLane, 0, 0);
      } finally {
        interveningGlobalGate.resolve();
        vi.useRealTimers();
      }
    });
  });

  it("keeps a session alive while another run's stalled global task times out", async () => {
    const { controller, sessionLane, globalLane } = createLaneController("global-successor");
    setCommandLaneConcurrency(globalLane, 1);

    const stalledGlobalTaskStarted = createDeferred();
    const { controller: stalledController } = createLaneController("stalled-global-owner", {
      globalLane,
    });
    const run = controller.enqueueSession(
      async () => {
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
      },
      { taskTimeoutMs: 25 },
    );
    const completedRun = expect(run).resolves.toEqual({ meta: { durationMs: 1 } });

    await stalledGlobalTaskStarted.promise;
    await expectLaneCounts(sessionLane, 1, 0);
    await expectLaneCounts(globalLane, 1, 1);

    await completedRun;
    expect(stalledController.abortSignal.aborted).toBe(true);
    expect(controller.abortSignal.aborted).toBe(false);
    await expectEmptyLanes(sessionLane, globalLane);
  });
});
