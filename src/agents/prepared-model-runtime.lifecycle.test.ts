import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { runNodeScript } from "../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createPreparedModelRuntimePluginDrain } from "./prepared-model-runtime.lifecycle.js";
import { PreparedModelRuntimePublicationQueue } from "./prepared-model-runtime.publication-queue.js";
import { agentProcessTestEntrypoints } from "./process-runtime.test-support.js";

it("releases completed run history while retired generation signals remain reachable", async ({
  signal,
}) => {
  const result = await runNodeScript(
    (workerArgv) => [
      "--expose-gc",
      ...workerArgv(resolveRuntimeWorkerUrl(agentProcessTestEntrypoints.modelGenerationRetention)),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result.error, result.stderr).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ generations: 128, retainedBytes: 0 });
});

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
