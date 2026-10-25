import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it } from "vitest";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { outsideExecutionCapacity, withReleasableExecutionCapacity } from "./execution-capacity.js";

const lane = "projection-recovery-capacity";

afterEach(() => {
  resetCommandQueueStateForTest();
});

it("lets another session run during recovery and reacquires in queue order", async () => {
  setCommandLaneConcurrency(lane, 1);
  const recoveryStarted = createDeferredCore();
  const finishRecovery = createDeferredCore();
  const siblingStarted = createDeferredCore();
  const finishSibling = createDeferredCore();
  const reacquisitionQueued = createDeferredCore();
  const order: string[] = [];
  const context = new AsyncLocalStorage<string>();
  let tickets = 0;
  const enqueue: CommandQueueEnqueueFn = (task, options) => {
    tickets += 1;
    const queued = enqueueCommandInLane(lane, task, options);
    if (tickets === 2) {
      reacquisitionQueued.resolve();
    }
    return queued;
  };
  const work = withReleasableExecutionCapacity(enqueue, () =>
    context.run("original", async () => {
      order.push("start");
      const value = await outsideExecutionCapacity(async () => {
        expect(context.getStore()).toBe("original");
        recoveryStarted.resolve();
        await finishRecovery.promise;
        return "recovered";
      });
      order.push("resume");
      return value;
    }),
  );
  const sibling = enqueueCommandInLane(lane, async () => {
    order.push("sibling");
    siblingStarted.resolve();
    await finishSibling.promise;
  });
  let ahead: Promise<void> | undefined;
  try {
    await Promise.all([recoveryStarted.promise, siblingStarted.promise]);
    expect(order).toEqual(["start", "sibling"]);
    ahead = enqueueCommandInLane(lane, async () => {
      order.push("ahead");
    });
    finishRecovery.resolve();
    await reacquisitionQueued.promise;
    expect(getCommandLaneSnapshot(lane)).toMatchObject({ activeCount: 1, queuedCount: 2 });
    finishSibling.resolve();
    await expect(work).resolves.toBe("recovered");
    await Promise.all([sibling, ahead]);
    expect(order).toEqual(["start", "sibling", "ahead", "resume"]);
    expect(tickets).toBe(2);
  } finally {
    finishRecovery.resolve();
    finishSibling.resolve();
    await Promise.allSettled([work, sibling, ...(ahead ? [ahead] : [])]);
  }
});

it("reacquires capacity before propagating a recovery failure through cleanup", async () => {
  const failure = new Error("projection recovery failed");
  const cleanupCapacity: number[] = [];
  const work = withReleasableExecutionCapacity(
    (task, options) => enqueueCommandInLane(lane, task, options),
    async () => {
      try {
        await outsideExecutionCapacity(async () => {
          expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
          throw failure;
        });
      } finally {
        cleanupCapacity.push(getCommandLaneSnapshot(lane).activeCount);
      }
    },
  );
  await expect(work).rejects.toBe(failure);
  expect(cleanupCapacity).toEqual([1]);
  expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
});

it("joins the suspended task's cleanup when capacity readmission is refused", async () => {
  const failure = new Error("readmission refused");
  const cleanupStarted = createDeferredCore();
  const finishCleanup = createDeferredCore();
  let tickets = 0;
  let cleanupDone = false;
  let settled = false;
  const enqueue: CommandQueueEnqueueFn = (task, options) =>
    ++tickets === 1 ? enqueueCommandInLane(lane, task, options) : Promise.reject(failure);
  const work = withReleasableExecutionCapacity(enqueue, async () => {
    try {
      await outsideExecutionCapacity(async () => "recovered");
    } finally {
      cleanupStarted.resolve();
      await finishCleanup.promise;
      cleanupDone = true;
    }
  });
  const outcome = work.then(
    () => {
      settled = true;
      return undefined;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await cleanupStarted.promise;
    expect(settled).toBe(false);
    finishCleanup.resolve();
    expect(await outcome).toBe(failure);
    expect(cleanupDone).toBe(true);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
  } finally {
    finishCleanup.resolve();
    await outcome;
  }
});
