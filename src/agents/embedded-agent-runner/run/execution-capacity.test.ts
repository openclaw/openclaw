import { AsyncLocalStorage } from "node:async_hooks";
import { afterEach, expect, it, vi } from "vitest";
import {
  getModelTransportContext,
  withModelTransportContext,
} from "../../../llm/model-transport-context.js";
import {
  enqueueCommandInLane,
  getCommandLaneSnapshot,
  setCommandLaneConcurrency,
} from "../../../process/command-queue.js";
import { resetCommandQueueStateForTest } from "../../../process/command-queue.test-support.js";
import type { CommandQueueEnqueueFn } from "../../../process/command-queue.types.js";
import { AsyncContext } from "../../../shared/async-context.js";
import { createDeferredCore } from "../../../shared/deferred.js";
import { outsideExecutionCapacity, withReleasableExecutionCapacity } from "./execution-capacity.js";

const lane = "projection-recovery-capacity";

afterEach(resetCommandQueueStateForTest);

it("shares one native carrier for turn capacity and model context", async () => {
  const ambient = new AsyncContext<string>(Symbol("ambient-turn"));
  const model = { requestId: "synthetic-request" };
  using runs = vi.spyOn(AsyncLocalStorage.prototype, "run");
  using entries = vi.spyOn(AsyncLocalStorage.prototype, "enterWith");
  await ambient.run("caller", () =>
    withModelTransportContext(model, () =>
      withReleasableExecutionCapacity(
        (task) => task(),
        async () => {
          await Promise.resolve();
          expect(ambient.getStore()).toBe("caller");
          expect(getModelTransportContext()).toBe(model);
        },
      ),
    ),
  );
  expect(getModelTransportContext()).toBeUndefined();
  expect(ambient.getStore()).toBeUndefined();
  // Each additional native carrier is copied by every later work-scope transition.
  expect(new Set([...runs.mock.contexts, ...entries.mock.contexts]).size).toBe(1);
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

it.each([false, true])("joins failed recovery (readmission refused=%s)", async (refused) => {
  const failure = new Error(refused ? "readmission refused" : "projection recovery failed");
  const cleanupStarted = createDeferredCore();
  const finishCleanup = createDeferredCore();
  const cleanupCapacity: number[] = [];
  let tickets = 0;
  let cleanupDone = false;
  const settled = vi.fn();
  const enqueue: CommandQueueEnqueueFn = (task, options) =>
    ++tickets > 1 && refused ? Promise.reject(failure) : enqueueCommandInLane(lane, task, options);
  const work = withReleasableExecutionCapacity(enqueue, async () => {
    try {
      await outsideExecutionCapacity(async () => {
        expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
        if (!refused) {
          throw failure;
        }
        return "recovered";
      });
    } finally {
      cleanupCapacity.push(getCommandLaneSnapshot(lane).activeCount);
      cleanupStarted.resolve();
      await finishCleanup.promise;
      cleanupDone = true;
    }
  });
  const outcome = work.catch((error: unknown) => error).finally(settled);
  try {
    await cleanupStarted.promise;
    expect(settled).not.toHaveBeenCalled();
    finishCleanup.resolve();
    expect(await outcome).toBe(failure);
    expect(cleanupCapacity).toEqual([refused ? 0 : 1]);
    expect(cleanupDone).toBe(true);
    expect(getCommandLaneSnapshot(lane).activeCount).toBe(0);
  } finally {
    finishCleanup.resolve();
    await outcome;
  }
});
