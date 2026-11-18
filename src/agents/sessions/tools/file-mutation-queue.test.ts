import { expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
import { withFileMutationQueueKeysResolution } from "./file-mutation-queue.js";

it("reserves files in source-call order without holding admission while a file operation runs", async () => {
  const keys = createDeferred<readonly string[]>();
  const release = createDeferred();
  const events: string[] = [];
  const first = withFileMutationQueueKeysResolution(keys.promise, async () => {
    events.push("first");
    await release.promise;
  });
  const second = withFileMutationQueueKeysResolution(Promise.resolve(["same-file"]), async () => {
    events.push("second");
  });
  const unrelated = withFileMutationQueueKeysResolution(
    Promise.resolve(["other-file"]),
    async () => {
      events.push("unrelated");
    },
  );
  try {
    keys.resolve(["same-file"]);
    await unrelated;
    expect(events).toEqual(["first", "unrelated"]);
    release.resolve();
    await Promise.all([first, second]);
    expect(events).toEqual(["first", "unrelated", "second"]);
  } finally {
    keys.resolve(["same-file"]);
    release.resolve();
    await Promise.allSettled([first, second, unrelated]);
  }
});

it("cancels and bounds queued waits without admitting them past a running holder", async () => {
  vi.useFakeTimers();
  const release = createDeferred();
  const entered = createDeferred();
  const finishWriter = createDeferred();
  const events: string[] = [];
  const pending: Promise<unknown>[] = [];
  const queue = (key: string, task: () => Promise<void>, signal?: AbortSignal) =>
    withFileMutationQueueKeysResolution(Promise.resolve([key]), task, signal);
  const holder = queue("busy-file", async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    await vi.advanceTimersByTimeAsync(1_000);
    const controller = new AbortController();
    const canceled = queue(
      "busy-file",
      async () => {
        events.push("canceled");
      },
      controller.signal,
    );
    let canceledError: unknown;
    const aborted = canceled.catch((error: unknown) => {
      canceledError = error;
    });
    await queue("unrelated-file", async () => {
      events.push("unrelated");
    });
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    const waiting = queue("busy-file", async () => {
      events.push("expired");
    });
    let timeoutError: unknown;
    const expired = waiting.catch((error: unknown) => {
      timeoutError = error;
    });
    pending.push(aborted, expired);
    await vi.advanceTimersByTimeAsync(180_000);
    expect.soft(canceledError).toMatchObject({ name: "AbortError" });
    expect.soft(timeoutError).toMatchObject({
      message: expect.stringMatching(
        /file is busy.*earlier operation.*181 seconds.*retry later.*another file.*restart the Gateway/i,
      ),
    });
    const successor = queue("busy-file", async () => {
      events.push("successor");
    });
    pending.push(successor);
    await queue("unrelated-file", async () => {
      events.push("still unrelated");
    });
    expect(events).toEqual(["unrelated", "still unrelated"]);
    release.resolve();
    await Promise.all([holder, successor]);
    expect(events).toEqual(["unrelated", "still unrelated", "successor"]);

    const writerEntered = createDeferred();
    const writerAbort = new AbortController();
    const writer = queue(
      "active-writer",
      async () => {
        writerEntered.resolve();
        await finishWriter.promise;
        events.push("writer settled");
      },
      writerAbort.signal,
    );
    pending.push(writer);
    await writerEntered.promise;
    const observer = racePromiseWithAbortSignal(writer, writerAbort.signal);
    writerAbort.abort();
    await expect(observer).rejects.toMatchObject({ name: "AbortError" });
    const nextWriter = queue("active-writer", async () => {
      events.push("next writer");
    });
    pending.push(nextWriter);
    await queue("unrelated-file", async () => {});
    expect(events).not.toContain("next writer");
    finishWriter.resolve();
    await Promise.all([writer, nextWriter]);
    expect(events.slice(-2)).toEqual(["writer settled", "next writer"]);
  } finally {
    release.resolve();
    finishWriter.resolve();
    await Promise.allSettled([holder, ...pending]);
    vi.useRealTimers();
  }
});
