import { setImmediate as nextTurn, setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { getAgentEventLifecycleGeneration } from "../../../infra/agent-events.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { drainGlobalSingletonLifecycleState } from "../../../shared/global-singleton.js";
import { createSessionMaintenanceOwner } from "../../session-maintenance/coordinator.js";
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
      const successorController = createLaneController({
        sessionLane,
        runId: `successor-${termination}`,
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
    const sessionLane = "test:session-timeout-late-resumption";
    const globalLane = "test:global-timeout-late-resumption";
    const maintenanceGate = createDeferred();
    const lateTaskSettled = createDeferred();
    let enteredGlobalAdmission = false;
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "session-timeout-late-resumption",
    });

    const timedOut = controller.enqueueSession(
      async () => {
        try {
          await maintenanceGate.promise;
          controller.throwIfAborted();
          return await controller.enqueueGlobal(async () => {
            enteredGlobalAdmission = true;
            return { meta: { durationMs: 1 } };
          });
        } finally {
          lateTaskSettled.resolve();
        }
      },
      { taskTimeoutMs: 25 },
    );

    await expect(timedOut).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
    expect(controller.abortSignal.aborted).toBe(true);

    maintenanceGate.resolve();
    await lateTaskSettled.promise;
    expect(enteredGlobalAdmission).toBe(false);
    await expectLaneCounts(sessionLane, 0, 0);
    await expectLaneCounts(globalLane, 0, 0);
  });

  it("keeps the session lease alive until every concurrent global admission settles", async () => {
    const sessionLane = "test:session-concurrent-global-admission";
    const globalLane = "test:concurrent-global-admission";
    setCommandLaneConcurrency(globalLane, 1);

    const interveningGlobalGate = createDeferred();
    const interveningGlobalTaskStarted = createDeferred();
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
            interveningGlobalTaskStarted.resolve();
            await interveningGlobalGate.promise;
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
      await interveningGlobalTaskStarted.promise;
      await delay(75);
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
    }
  });

  it("times out a stalled global task while another global admission keeps the session alive", async () => {
    const sessionLane = "test:session-stalled-global-with-successor";
    const globalLane = "test:stalled-global-with-successor";
    setCommandLaneConcurrency(globalLane, 1);

    const stalledGlobalTaskStarted = createDeferred();
    const controller = createLaneController({
      sessionLane,
      globalLane,
      runId: "stalled-global-with-successor",
    });
    const run = controller.enqueueSession(
      async () => {
        const stalledGlobalAdmission = controller.enqueueGlobal(
          async () => {
            stalledGlobalTaskStarted.resolve();
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

    await stalledGlobalTaskStarted.promise;
    await expectLaneCounts(sessionLane, 1, 0);
    await expectLaneCounts(globalLane, 1, 1);

    await completedRun;
    await expectLaneCounts(sessionLane, 0, 0);
    await expectLaneCounts(globalLane, 0, 0);
  });
});

describe("foreground cancellation before queue admission", () => {
  afterEach(async () => {
    await drainGlobalSingletonLifecycleState("close");
  });

  it.each(
    [false, true].flatMap((preemptible) =>
      ["error", "string"].map((reasonType) => ({ preemptible, reasonType })),
    ),
  )(
    "settles $reasonType Stop before held maintenance cleanup, preemptible=$preemptible",
    async ({ preemptible, reasonType }) => {
      const key = `foreground-maintenance-${preemptible}`;
      const started = createDeferred();
      const cleanup = createDeferred();
      const owner = createSessionMaintenanceOwner({ sessionKey: key, preemptible });
      let writerFinished = false;
      const work = owner.track(
        owner.run(async () => {
          started.resolve();
          await cleanup.promise;
          writerFinished = true;
        }),
      );
      await started.promise;
      const abort = new AbortController();
      const reason =
        reasonType === "error" ? new Error("foreground stopped") : "foreground stopped";
      let generation = getAgentEventLifecycleGeneration();
      let params: RunEmbeddedAgentParams & { sessionFile: string } = {
        abortSignal: abort.signal,
        lifecycleGeneration: generation,
        prompt: "hello",
        runId: key,
        sessionFile: key,
        sessionId: key,
        sessionKey: key,
        timeoutMs: 30_000,
        trigger: "user",
        workspaceDir: "/tmp",
      };
      const controller = createEmbeddedRunLaneController({
        getLifecycleGeneration: () => generation,
        getParams: () => params,
        globalLane: `${key}-global`,
        initialQueuedLifecycleGeneration: generation,
        sessionLane: key,
        setLifecycleGeneration: (next) => {
          generation = next;
        },
        setParams: (next) => {
          params = next;
        },
      });
      let taskRan = false;
      let settled = false;
      const run = controller
        .enqueueSession(async () => {
          taskRan = true;
        })
        .then(
          () => {
            settled = true;
            return undefined;
          },
          (error: unknown) => {
            settled = true;
            return error;
          },
        );
      abort.abort(reason);
      let beforeCleanup: { settled: boolean; writerFinished: boolean; taskRan: boolean };
      try {
        await nextTurn();
        beforeCleanup = { settled, writerFinished, taskRan };
        expect(getCommandLaneSnapshot(key).queuedCount).toBe(0);
        expect(beforeCleanup.writerFinished).toBe(false);
        expect(beforeCleanup.taskRan).toBe(false);
        expect(owner.signal.aborted).toBe(preemptible);
        expect(
          beforeCleanup.settled,
          "Stop must settle independently of an unrelated writer's held cleanup",
        ).toBe(true);
      } finally {
        cleanup.resolve();
        await work;
        await run;
      }
      if (reason instanceof Error) {
        expect(await run).toBe(reason);
      } else {
        expect(await run).toMatchObject({ name: "AbortError", cause: reason });
      }
      expect(writerFinished).toBe(true);
      expect(taskRan).toBe(false);
      // A later optional owner must remain usable after the canceled caller drains.
      const successorAbort = new AbortController();
      const successor = createSessionMaintenanceOwner({
        sessionKey: key,
        preemptible: true,
        abortSignal: successorAbort.signal,
      });
      let successorRan = false;
      const successorWork = successor.track(
        successor.run(async () => {
          successorRan = true;
        }),
      );
      try {
        await nextTurn();
        expect(successorRan).toBe(true);
      } finally {
        successorAbort.abort();
        await Promise.allSettled([successorWork]);
      }
    },
  );

  it("surfaces a non-abort admission failure even once the lane signal is aborted", async () => {
    const key = "foreground-maintenance-real-failure";
    const abort = new AbortController();
    const failure = new Error("maintenance store unavailable");
    vi.resetModules();
    vi.doMock("../../session-maintenance/coordinator.js", async (importOriginal) => ({
      ...(await importOriginal<typeof import("../../session-maintenance/coordinator.js")>()),
      // Cancel first, so the lane's catch sees an aborted signal alongside a real failure.
      beginForegroundSessionMaintenance: async () => {
        abort.abort(new Error("user stopped"));
        throw failure;
      },
    }));
    try {
      const { createEmbeddedRunLaneController: createController } =
        await import("./lane-controller.js");
      let generation = getAgentEventLifecycleGeneration();
      let params: RunEmbeddedAgentParams & { sessionFile: string } = {
        abortSignal: abort.signal,
        lifecycleGeneration: generation,
        prompt: "hello",
        runId: key,
        sessionFile: key,
        sessionId: key,
        sessionKey: key,
        timeoutMs: 30_000,
        trigger: "user",
        workspaceDir: "/tmp",
      };
      const controller = createController({
        getLifecycleGeneration: () => generation,
        getParams: () => params,
        globalLane: `${key}-global`,
        initialQueuedLifecycleGeneration: generation,
        sessionLane: key,
        setLifecycleGeneration: (next) => {
          generation = next;
        },
        setParams: (next) => {
          params = next;
        },
      });
      let taskRan = false;
      await expect(
        controller.enqueueSession(async () => {
          taskRan = true;
        }),
      ).rejects.toBe(failure);
      expect(taskRan).toBe(false);
    } finally {
      vi.doUnmock("../../session-maintenance/coordinator.js");
      vi.resetModules();
    }
  });
});
