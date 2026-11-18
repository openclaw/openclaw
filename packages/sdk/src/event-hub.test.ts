import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { resolveRuntimeWorkerUrl } from "../../../src/infra/runtime-worker-url.js";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { EventHub } from "./event-hub.js";
import { eventHubRetentionEntrypoint } from "./retention-runtime.test-support.js";

function subscriber<T>(filter?: (event: T) => boolean) {
  const hub = new EventHub<T>();
  return { hub, iterator: hub.stream(filter)[Symbol.asyncIterator]() };
}
const done = { done: true, value: undefined };

it("releases retired payloads but lets a closed hub drain", async ({ signal }) => {
  const result = await runNodeScript(
    (workerArgv) => [
      "--expose-gc",
      ...workerArgv(resolveRuntimeWorkerUrl(eventHubRetentionEntrypoint)),
    ],
    { ...process.env, NODE_OPTIONS: "", TSX_DISABLE_CACHE: "1" },
    15_000,
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      signal,
      maxBuffer: 64 * 1024,
      requireProcessTreeExit: process.platform !== "win32",
    },
  );
  expect(result, result.stderr).toMatchObject({ error: undefined, status: 0 });
  expect(JSON.parse(result.stdout)).toEqual({ verdict: "passed", cleanupErrors: [] });
}, 30_000);

it("keeps buffered bursts ordered when publishing resumes during a partial drain", async () => {
  const { hub, iterator } = subscriber<number | undefined>();
  const first = Array.from({ length: 4097 }, (_, index) => (index % 17 ? index : undefined));
  const second = Array.from({ length: 2051 }, (_, index) => index + 4097);
  first.forEach((event) => hub.publish(event));

  const seen: Array<number | undefined> = [];
  for (let index = 0; index < 2500; index++) {
    const event = await iterator.next();
    expect(event.done).toBe(false);
    seen.push(event.value);
  }
  second.forEach((event) => hub.publish(event));
  hub.close();
  for await (const event of { [Symbol.asyncIterator]: () => iterator }) {
    seen.push(event);
  }

  expect(seen).toEqual([...first, ...second]);
  await expect(iterator.next()).resolves.toEqual(done);
});

it("preserves nested publish order when a subscriber filter emits another event", async () => {
  const { hub, iterator: filtered } = subscriber<string>((event) => {
    if (event === "outer") {
      hub.publish("inner");
    }
    return true;
  });
  const healthy = hub.stream()[Symbol.asyncIterator]();
  hub.publish("outer");
  hub.close();

  for (const iterator of [filtered, healthy]) {
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "inner" });
    await expect(iterator.next()).resolves.toEqual({ done: false, value: "outer" });
    await expect(iterator.next()).resolves.toEqual(done);
  }
});

it("reserves a published event for the reader it wakes", async () => {
  const { hub, iterator } = subscriber<string>();
  const first = iterator.next();

  hub.publish("first");
  const second = iterator.next();
  hub.publish("second");

  await expect(Promise.all([first, second])).resolves.toEqual([
    { done: false, value: "first" },
    { done: false, value: "second" },
  ]);
});

it.each(["iterator return", "hub error"])("settles every pending read on %s", async (mode) => {
  const { hub, iterator } = subscriber<string>();
  const pending = [iterator.next(), iterator.next()];
  if (mode === "hub error") {
    hub.close(new Error("gateway event stream closed"));
    for (const read of pending) {
      await expect(read).rejects.toThrow("gateway event stream closed");
    }
  } else {
    await expect(iterator.return?.()).resolves.toEqual(done);
    await expect(Promise.all(pending)).resolves.toEqual([done, done]);
  }
});
