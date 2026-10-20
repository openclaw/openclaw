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
  it("reports a failed checkpoint and catches up on the next update", async () => {
    let failFirstWrite = true;
    const { persistence, writes, onError } = createPersistence(async () => {
      if (failFirstWrite) {
        failFirstWrite = false;
        throw new Error("offset store unavailable");
      }
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    expect(writes).toEqual([101]);
    expect(persistence.getCommittedUpdateId()).toBe(100);
    persistence.persistUpdateId(103);
    persistence.persistUpdateId(102);

    await flushMicrotasks();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ updateId: 101 }));
    expect(writes).toEqual([101, 103]);
    expect(persistence.getCommittedUpdateId()).toBe(103);
    await persistence.stop();
  });

  it("never regresses when a lower update arrives during a higher write", async () => {
    const write = createDeferred<void>();
    const { persistence, writes } = createPersistence(async () => {
      await write.promise;
    });

    persistence.persistUpdateId(103);
    persistence.persistUpdateId(102);
    await flushMicrotasks();
    write.resolve();
    await flushMicrotasks();

    expect(writes).toEqual([103]);
    expect(persistence.getCommittedUpdateId()).toBe(103);
    await persistence.stop();
  });

  it("restarts the drain when a higher update arrives during teardown", async () => {
    const firstWrite = createDeferred<void>();
    const { persistence, writes } = createPersistence(async (updateId) => {
      if (updateId === 101) {
        await firstWrite.promise;
      }
    });

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    firstWrite.resolve();
    queueMicrotask(() => persistence.persistUpdateId(102));
    await vi.waitFor(() => expect(writes).toEqual([101, 102]));

    expect(persistence.getCommittedUpdateId()).toBe(102);
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

  it("does not start another checkpoint after the supplied signal aborts", async () => {
    const abortController = new AbortController();
    const writeUpdateId = vi.fn(async () => {
      throw new Error("offset store unavailable");
    });
    const { persistence } = createPersistence(writeUpdateId, abortController.signal);

    persistence.persistUpdateId(101);
    await flushMicrotasks();
    abortController.abort();
    persistence.persistUpdateId(102);
    await flushMicrotasks();

    expect(writeUpdateId).toHaveBeenCalledTimes(1);
    expect(persistence.getCommittedUpdateId()).toBe(100);
    await persistence.stop();
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
