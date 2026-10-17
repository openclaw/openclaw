// Telegram tests cover monotonic update-offset checkpointing.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTelegramUpdateOffsetPersistence } from "./update-offset-persistence.js";

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createTelegramUpdateOffsetPersistence", () => {
  it("reports a failed checkpoint and catches up on the next update", async () => {
    const writes: number[] = [];
    let failFirstWrite = true;
    const onError = vi.fn();
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error("offset store unavailable");
        }
      },
      onInvalidUpdateId: vi.fn(),
      onError,
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
    const writes: number[] = [];
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
        await write.promise;
      },
      onInvalidUpdateId: vi.fn(),
      onError: vi.fn(),
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
    const writes: number[] = [];
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
        if (updateId === 101) {
          await firstWrite.promise;
        }
      },
      onInvalidUpdateId: vi.fn(),
      onError: vi.fn(),
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
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async () => await write.promise,
      onInvalidUpdateId: vi.fn(),
      onError: vi.fn(),
    });

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
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId,
      onInvalidUpdateId: vi.fn(),
      onError: vi.fn(),
      abortSignal: abortController.signal,
    });

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
    const writes: number[] = [];
    const onInvalidUpdateId = vi.fn();
    const persistence = createTelegramUpdateOffsetPersistence({
      initialUpdateId: 100,
      writeUpdateId: async (updateId) => {
        writes.push(updateId);
      },
      onInvalidUpdateId,
      onError: vi.fn(),
    });

    persistence.persistUpdateId(Number.NaN);
    persistence.persistUpdateId(101);
    await flushMicrotasks();

    expect(onInvalidUpdateId).toHaveBeenCalledWith(Number.NaN);
    expect(writes).toEqual([101]);
    expect(persistence.getCommittedUpdateId()).toBe(101);
    await persistence.stop();
  });
});
