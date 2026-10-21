import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it, vi } from "vitest";
import { createTelegramUpdateOffsetPersistence } from "./update-offset-persistence.js";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function createPersistence(
  writeUpdateId: (id: number) => Promise<void> = async () => {},
  abortSignal?: AbortSignal,
) {
  const writes: number[] = [];
  const onError = vi.fn();
  const onInvalidUpdateId = vi.fn();
  const persistence = createTelegramUpdateOffsetPersistence({
    initialUpdateId: 100,
    writeUpdateId: (id) => {
      writes.push(id);
      return writeUpdateId(id);
    },
    onError,
    onInvalidUpdateId,
    abortSignal,
  });
  return { persistence, writes, onError, onInvalidUpdateId };
}

describe("createTelegramUpdateOffsetPersistence", () => {
  it.each([false, true])("handles a failed checkpoint (abort=%s)", async (abort) => {
    const controller = new AbortController();
    let failFirstWrite = true;
    const writeUpdateId = vi.fn(async () => {
      if (failFirstWrite) {
        failFirstWrite = false;
        throw new Error("offset store unavailable");
      }
    });
    const { persistence, writes, onError } = createPersistence(
      writeUpdateId,
      abort ? controller.signal : undefined,
    );

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    expect(writes).toEqual([101]);
    expect(persistence.getCommittedUpdateId()).toBe(100);
    if (abort) {
      controller.abort();
    }
    persistence.persistUpdateId(103);
    persistence.persistUpdateId(102);

    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ updateId: 101 }));
    expect(writes).toEqual(abort ? [101] : [101, 103]);
    expect(writeUpdateId).toHaveBeenCalledTimes(abort ? 1 : 2);
    expect(persistence.getCommittedUpdateId()).toBe(abort ? 100 : 103);
    await persistence.stop();
  });

  it.each([
    { timing: "during write", first: 103, next: 102, expected: [103] },
    { timing: "during teardown", first: 101, next: 102, expected: [101, 102] },
  ])("checkpoints a new offset arriving $timing", async ({ timing, first, next, expected }) => {
    const write = createDeferred<void>();
    const { persistence, writes } = createPersistence(async (id) => {
      if (id === first) {
        await write.promise;
      }
    });
    persistence.persistUpdateId(first);
    if (timing === "during write") {
      persistence.persistUpdateId(next);
    }
    await flushMicrotasks();
    write.resolve();
    if (timing === "during teardown") {
      queueMicrotask(() => persistence.persistUpdateId(next));
      await vi.waitFor(() => expect(writes).toEqual(expected));
    } else {
      await flushMicrotasks();
    }
    expect(writes).toEqual(expected);
    expect(persistence.getCommittedUpdateId()).toBe(expected.at(-1));
    await persistence.stop();
  });

  it("fences an in-flight write before stop resolves", async () => {
    const write = createDeferred<void>();
    const { persistence } = createPersistence(async () => await write.promise);

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    let stopped = false;
    const stop = persistence.stop().then(() => {
      stopped = true;
    });
    await flushMicrotasks();
    expect(stopped).toBe(false);

    write.resolve();
    await stop;
    expect(stopped).toBe(true);
    expect(persistence.getCommittedUpdateId()).toBe(101);
  });

  it("ignores a malformed update ID without blocking the next valid write", async () => {
    const { persistence, writes, onInvalidUpdateId } = createPersistence();

    persistence.persistUpdateId(Number.NaN);
    persistence.persistUpdateId(101);
    await flushMicrotasks();

    expect(onInvalidUpdateId).toHaveBeenCalledWith(Number.NaN);
    expect(writes).toEqual([101]);
    expect(persistence.getCommittedUpdateId()).toBe(101);
    await persistence.stop();
  });
});
