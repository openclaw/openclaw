import { setImmediate } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { collect } from "../../../../test/helpers/async-iterable.js";
import { runRetentionNodeScript } from "../../../../test/helpers/run-node-script.js";
import { eventStreamRetentionEntrypoint } from "../retention-runtime.test-support.js";
import { EventStream, getEventStreamCompletion } from "./event-stream.js";

const createNumberStream = () =>
  new EventStream<number>(
    (event) => event === -1,
    (event) => event,
  );

describe("EventStream", () => {
  it("releases consumed events but retains unread events and results", async ({ signal }) => {
    const result = await runRetentionNodeScript(eventStreamRetentionEntrypoint, {
      cwd: fileURLToPath(new URL("../../../../", import.meta.url)),
      signal,
    });
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { completed: false, consumedRetained: false, finalRetained: false },
      { completed: true, consumedRetained: false, finalRetained: true },
    ]);
  }, 30_000);

  it("preserves interleaved queued and waiting push/pull order", async () => {
    const stream = createNumberStream();
    const iterator = stream[Symbol.asyncIterator]();

    stream.push(1);
    expect(await iterator.next()).toEqual({ value: 1, done: false });

    const waiting = iterator.next();
    stream.push(2);
    expect(await waiting).toEqual({ value: 2, done: false });

    stream.push(3);
    stream.end();
    expect(await iterator.next()).toEqual({ value: 3, done: false });
    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });

  it("preserves queued events across prefix compaction and subsequent pushes", async () => {
    const stream = createNumberStream();
    const iterator = stream[Symbol.asyncIterator]();
    for (let value = 0; value < 2048; value += 1) {
      stream.push(value);
    }

    const read = (length: number) => Promise.all(Array.from({ length }, () => iterator.next()));
    expect(await read(1024)).toEqual(
      Array.from({ length: 1024 }, (_, value) => ({ value, done: false })),
    );
    for (let value = 2048; value < 2052; value += 1) {
      stream.push(value);
    }
    stream.end();
    expect(await collect({ [Symbol.asyncIterator]: () => iterator })).toEqual(
      Array.from({ length: 1028 }, (_, index) => index + 1024),
    );
  });

  it.each<[number, number | undefined, number]>([
    [-1, undefined, -1],
    [7, 42, 42],
  ])("settles event %s/end(%s) with %s", async (event, result, expected) => {
    const stream = createNumberStream();
    stream.push(event);
    stream.end(result);
    await expect(stream.result()).resolves.toBe(expected);
    await expect(getEventStreamCompletion(stream)).resolves.toBe(expected);
  });

  it("rejects bare-end results without unhandled rejections for iterate-only consumers", async () => {
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const stream = createNumberStream();
      stream.push(1);
      stream.end();
      expect(await collect(stream)).toEqual([1]);
      await setImmediate(); // Let any unhandled rejection surface.
      expect(rejections).toEqual([]);
      const error = "event stream ended without a terminal event or final result";
      await expect(stream.result()).rejects.toThrow(error);
      await expect(getEventStreamCompletion(stream)).rejects.toThrow(error);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});
