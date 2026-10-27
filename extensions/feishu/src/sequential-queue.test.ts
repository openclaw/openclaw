import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSequentialQueue } from "./sequential-queue.js";

type Enqueue = ReturnType<typeof createSequentialQueue>;
function gatedTask(enqueue: Enqueue, key: string, label: string, order: string[]) {
  const gate = createDeferred<void>();
  const started = createDeferred<void>();
  const done = enqueue(key, async () => {
    order.push(`${label}:start`);
    started.resolve();
    await gate.promise;
    order.push(`${label}:end`);
  });
  return { release: () => gate.resolve(), started: started.promise, done };
}

describe("createSequentialQueue", () => {
  afterEach(() => vi.useRealTimers());

  it.each([false, true])("orders tasks with concurrent keys=%s", async (concurrent) => {
    const enqueue = createSequentialQueue();
    const order: string[] = [];
    const first = gatedTask(enqueue, "chat", "first", order);
    const second = gatedTask(enqueue, concurrent ? "chat:btw" : "chat", "second", order);
    await first.started;
    if (concurrent) {
      await second.started;
    }
    expect(order).toEqual(concurrent ? ["first:start", "second:start"] : ["first:start"]);
    first.release();
    await second.started;
    second.release();
    await Promise.all([first.done, second.done]);
    expect(order).toEqual(
      concurrent
        ? ["first:start", "second:start", "first:end", "second:end"]
        : ["first:start", "first:end", "second:start", "second:end"],
    );
  });

  it("does not leak unhandled rejections when a queued task fails", async () => {
    const enqueue = createSequentialQueue();
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandledRejection);

    try {
      await expect(
        enqueue("chat", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(unhandled).toStrictEqual([]);

      await expect(enqueue("chat", async () => {})).resolves.toBeUndefined();
    } finally {
      process.off("unhandledRejection", onUnhandledRejection);
    }
  });

  it("unblocks same-key work at the five-minute task deadline", async () => {
    vi.useFakeTimers();
    const onTaskTimeout = vi.fn();
    const enqueue = createSequentialQueue({ onTaskTimeout });
    const order: string[] = [];

    const stuck = gatedTask(enqueue, "stuck", "stuck", order);

    const followUp = enqueue("stuck", async () => {
      order.push("follow-up:ran");
    });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(order).toEqual(["stuck:start"]);
    expect(onTaskTimeout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await followUp;

    expect(order).toEqual(["stuck:start", "follow-up:ran"]);
    expect(onTaskTimeout).toHaveBeenCalledExactlyOnceWith("stuck", 300_000);

    stuck.release();
    await stuck.done;
  });
});
