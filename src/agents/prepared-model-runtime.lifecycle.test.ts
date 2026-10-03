import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { createPreparedModelRuntimePluginDrain } from "./prepared-model-runtime.lifecycle.js";
import { PreparedModelRuntimePublicationQueue } from "./prepared-model-runtime.publication-queue.js";

it("rechecks a successor plugin reservation after a publication reaches the queue", async () => {
  const signal = new AbortController().signal;
  const drain = createPreparedModelRuntimePluginDrain(
    () => signal,
    () => false,
  );
  const first = drain.begin();
  const queue = new PreparedModelRuntimePublicationQueue();
  const releaseQueue = createDeferred();
  const queued = createDeferred();
  const blocker = queue.enqueue(() => releaseQueue.promise);
  const enqueue = queue.enqueue.bind(queue);
  vi.spyOn(queue, "enqueue").mockImplementationOnce((task) => {
    const publication = enqueue(task);
    queued.resolve();
    return publication;
  });
  const writes: string[] = [];
  const publication = drain.runAfter(queue, async () => {
    writes.push("published");
  });
  let successor: ReturnType<typeof drain.begin> | undefined;
  try {
    first.release();
    await queued.promise;
    successor = drain.begin();
    releaseQueue.resolve();
    await queue.settle();
    expect(writes).toEqual([]);
    successor.release();
    await publication;
    expect(writes).toEqual(["published"]);
  } finally {
    first.release();
    successor?.release();
    releaseQueue.resolve();
    await Promise.allSettled([blocker, publication]);
  }
});
