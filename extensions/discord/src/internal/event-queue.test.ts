import { describe, expect, it, vi } from "vitest";
import { DiscordEventQueue } from "./event-queue.js";

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolve: (value: T | PromiseLike<T>) => void = () => {};
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

describe("DiscordEventQueue", () => {
  it("reports only pending jobs after the queue head advances", async () => {
    const queue = new DiscordEventQueue({ maxConcurrency: 1, listenerTimeout: 1_000 });
    const releases: Array<() => void> = [];
    const started: string[] = [];

    const enqueue = (listenerName: string) =>
      queue.enqueue({
        eventType: "READY",
        listenerName,
        run: async () => {
          started.push(listenerName);
          const release = createDeferred();
          releases.push(() => release.resolve());
          await release.promise;
        },
      });

    const first = enqueue("first");
    const second = enqueue("second");
    const third = enqueue("third");

    await vi.waitFor(() => expect(started).toEqual(["first"]));
    expect(queue.getMetrics()).toEqual(expect.objectContaining({ processing: 1, queueSize: 2 }));

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
    expect(queue.getMetrics()).toEqual(expect.objectContaining({ processing: 1, queueSize: 1 }));

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    releases.shift()?.();
    await expect(Promise.all([first, second, third])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("applies maxQueueSize to pending jobs after the queue head advances", async () => {
    const queue = new DiscordEventQueue({
      maxConcurrency: 1,
      maxQueueSize: 2,
      listenerTimeout: 1_000,
    });
    const releases: Array<() => void> = [];
    const started: string[] = [];

    const enqueue = (listenerName: string) =>
      queue.enqueue({
        eventType: "MESSAGE_CREATE",
        listenerName,
        run: async () => {
          started.push(listenerName);
          const release = createDeferred();
          releases.push(() => release.resolve());
          await release.promise;
        },
      });

    const first = enqueue("first");
    const second = enqueue("second");
    const third = enqueue("third");

    await vi.waitFor(() => expect(started).toEqual(["first"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["first", "second"]));

    const fourth = enqueue("fourth");
    expect(queue.getMetrics()).toEqual(expect.objectContaining({ processing: 1, queueSize: 2 }));
    await expect(enqueue("fifth")).rejects.toThrow(
      "Discord event queue is full for MESSAGE_CREATE; maxQueueSize=2",
    );

    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third"]));
    releases.shift()?.();
    await vi.waitFor(() => expect(started).toEqual(["first", "second", "third", "fourth"]));
    releases.shift()?.();

    await expect(Promise.all([first, second, third, fourth])).resolves.toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});
