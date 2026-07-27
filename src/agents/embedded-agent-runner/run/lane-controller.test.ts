import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { createEmbeddedRunLaneController } from "./lane-controller.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type LaneTestParams = RunEmbeddedAgentParams & { sessionFile: string };

function createLaneController(params: {
  sessionLane: string;
  globalLane?: string;
  runId: string;
  enqueue?: CommandQueueEnqueueFn;
}) {
  let runParams: LaneTestParams = {
    sessionId: params.runId,
    sessionFile: `${params.runId}.jsonl`,
    workspaceDir: "/tmp/openclaw-lane-controller-test",
    prompt: "test",
    timeoutMs: 1,
    runId: params.runId,
    trigger: "user",
    ...(params.enqueue ? { enqueue: params.enqueue } : {}),
  };
  let lifecycleGeneration = getAgentEventLifecycleGeneration();

  return createEmbeddedRunLaneController({
    getLifecycleGeneration: () => lifecycleGeneration,
    getParams: () => runParams,
    globalLane: params.globalLane ?? "test:embedded-global",
    initialQueuedLifecycleGeneration: lifecycleGeneration,
    sessionLane: params.sessionLane,
    setLifecycleGeneration: (generation) => {
      lifecycleGeneration = generation;
    },
    setParams: (nextParams) => {
      runParams = nextParams;
    },
  });
}

describe("embedded run session lane", () => {
  afterEach(() => {
    resetCommandQueueStateForTest();
  });

  it("passes the run deadline and lifecycle signals into injected session queues", async () => {
    let observedOptions: Parameters<CommandQueueEnqueueFn>[1];
    const enqueue: CommandQueueEnqueueFn = async (task, options) => {
      observedOptions = options;
      return await task();
    };
    const controller = createLaneController({
      sessionLane: "test:injected-session-deadline",
      runId: "injected-session-deadline",
      enqueue,
    });

    await expect(controller.enqueueSession(async () => "finished")).resolves.toBe("finished");
    expect(observedOptions).toMatchObject({
      priority: "foreground",
      taskTimeoutMs: 30_001,
      taskTimeoutAbortGraceMs: 30_000,
      taskTimeoutAbortSignal: controller.laneTaskAbortController.signal,
      taskTimeoutReleaseSignal: controller.laneTaskReleaseController.signal,
    });
    expect(observedOptions?.taskTimeoutProgressAtMs?.()).toEqual(expect.any(Number));
  });

  it.each(["deadline", "release"] as const)(
    "releases all queued session turns when the active turn reaches its %s",
    async (termination) => {
      const sessionLane = `test:session-stall-${termination}`;
      setCommandLaneConcurrency(sessionLane, 1);
      const stalledController = createLaneController({
        sessionLane,
        runId: `stalled-${termination}`,
      });
      const stalled = stalledController.enqueueSession(
        async () => await new Promise<never>(() => {}),
        { taskTimeoutMs: 25 },
      );
      const stalledFailure = expect(stalled).rejects.toMatchObject({
        name: "CommandLaneTaskTimeoutError",
      });
      const successors = Array.from({ length: 10 }, (_, index) => {
        const controller = createLaneController({
          sessionLane,
          runId: `successor-${termination}-${index}`,
        });
        return controller.enqueueSession(async () => index);
      });

      expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 10,
      });

      if (termination === "release") {
        stalledController.laneTaskReleaseController.abort();
      }

      await stalledFailure;
      await expect(Promise.all(successors)).resolves.toEqual(
        Array.from({ length: 10 }, (_, index) => index),
      );
      expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
      });
    },
  );

  it("keeps a session alive while its run waits for healthy global-lane admission", async () => {
    const sessionLane = "test:session-global-admission";
    const globalLane = "test:global-admission";
    setCommandLaneConcurrency(globalLane, 1);

    let releaseGlobalLane: () => void = () => {};
    const globalLaneGate = new Promise<void>((resolve) => {
      releaseGlobalLane = resolve;
    });
    const globalBlocker = enqueueCommandInLane(globalLane, async () => {
      await globalLaneGate;
    });
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "healthy-global-admission",
    });
    const run = controller.enqueueSession(
      async () => await controller.enqueueGlobal(async () => ({ meta: { durationMs: 1 } })),
      { taskTimeoutMs: 25 },
    );

    try {
      await delay(100);
      expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 0,
      });
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 1,
      });

      releaseGlobalLane();
      await globalBlocker;
      await expect(run).resolves.toMatchObject({ meta: { durationMs: 1 } });
      expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
      });
    } finally {
      releaseGlobalLane();
    }
  });

  it("keeps the session lease alive until every concurrent global admission settles", async () => {
    const sessionLane = "test:session-concurrent-global-admission";
    const globalLane = "test:concurrent-global-admission";
    setCommandLaneConcurrency(globalLane, 1);

    let releaseInterveningGlobalTask: () => void = () => {};
    const interveningGlobalGate = new Promise<void>((resolve) => {
      releaseInterveningGlobalTask = resolve;
    });
    let markInterveningGlobalTaskStarted: () => void = () => {};
    const interveningGlobalTaskStarted = new Promise<void>((resolve) => {
      markInterveningGlobalTaskStarted = resolve;
    });
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "healthy-concurrent-global-admission",
    });
    const run = controller.enqueueSession(
      async () => {
        const firstGlobalAdmission = controller.enqueueGlobal(async () => ({
          meta: { durationMs: 1 },
        }));
        const interveningGlobalTask = enqueueCommandInLane(
          globalLane,
          async () => {
            markInterveningGlobalTaskStarted();
            await interveningGlobalGate;
          },
          { priority: "foreground" },
        );
        const secondGlobalAdmission = controller.enqueueGlobal(async () => ({
          meta: { durationMs: 2 },
        }));
        return await Promise.all([
          firstGlobalAdmission,
          interveningGlobalTask,
          secondGlobalAdmission,
        ]);
      },
      { taskTimeoutMs: 25 },
    );

    try {
      await interveningGlobalTaskStarted;
      await delay(75);
      expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 0,
      });
      expect(getCommandLaneSnapshot(globalLane)).toMatchObject({
        activeCount: 1,
        queuedCount: 1,
      });

      releaseInterveningGlobalTask();
      await expect(run).resolves.toEqual([
        { meta: { durationMs: 1 } },
        undefined,
        { meta: { durationMs: 2 } },
      ]);
      expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
        activeCount: 0,
        queuedCount: 0,
      });
    } finally {
      releaseInterveningGlobalTask();
    }
  });

  it("times out a stalled global task while another global admission keeps the session alive", async () => {
    const sessionLane = "test:session-stalled-global-with-successor";
    const globalLane = "test:stalled-global-with-successor";
    setCommandLaneConcurrency(globalLane, 1);

    let markStalledGlobalTaskStarted: () => void = () => {};
    const stalledGlobalTaskStarted = new Promise<void>((resolve) => {
      markStalledGlobalTaskStarted = resolve;
    });
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "stalled-global-with-successor",
    });
    const run = controller.enqueueSession(
      async () => {
        const stalledGlobalAdmission = controller.enqueueGlobal(
          async () => {
            markStalledGlobalTaskStarted();
            return await new Promise<never>(() => {});
          },
          { taskTimeoutMs: 25 },
        );
        const stalledGlobalFailure = expect(stalledGlobalAdmission).rejects.toMatchObject({
          name: "CommandLaneTaskTimeoutError",
        });
        const successorGlobalAdmission = controller.enqueueGlobal(async () => ({
          meta: { durationMs: 1 },
        }));

        await stalledGlobalFailure;
        return await successorGlobalAdmission;
      },
      { taskTimeoutMs: 25 },
    );
    const completedRun = expect(run).resolves.toEqual({ meta: { durationMs: 1 } });

    await stalledGlobalTaskStarted;
    expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
      activeCount: 1,
      queuedCount: 0,
    });
    expect(getCommandLaneSnapshot(globalLane)).toMatchObject({
      activeCount: 1,
      queuedCount: 1,
    });

    await completedRun;
    expect(getCommandLaneSnapshot(sessionLane)).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
    });
    expect(getCommandLaneSnapshot(globalLane)).toMatchObject({
      activeCount: 0,
      queuedCount: 0,
    });
  });
});
