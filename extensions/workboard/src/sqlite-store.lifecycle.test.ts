import { deserialize, serialize } from "node:v8";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  encodeWorkboardSqliteFailure,
  unwrapWorkboardSqliteResult,
  type WorkboardSqliteResult,
} from "./sqlite-store-errors.js";

const { openEngineWorkerStore } = vi.hoisted(() => ({ openEngineWorkerStore: vi.fn() }));
vi.mock(import("openclaw/plugin-sdk/database-engine-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  openEngineWorkerStore,
}));
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

const workerModuleUrl = new URL("./sqlite-store.worker.ts", import.meta.url);
beforeEach(() => {
  openEngineWorkerStore.mockReset();
});

function workerFixture() {
  const execute = vi.fn<() => Promise<WorkboardSqliteResult<unknown>>>();
  const close = vi.fn(async () => {});
  openEngineWorkerStore.mockResolvedValue({ execute, close });
  const stores = createWorkboardSqliteStores({
    dbPath: "/unused-workboard-lifecycle.sqlite",
    workerModuleUrl,
  });
  return { execute, close, stores };
}

describe("Workboard SQLite facade cleanup", () => {
  it("retains the selected worker when wider lazy options contain a worker URL", async () => {
    const execute = vi.fn(async () => ({ ok: true, value: [] }));
    const close = vi.fn(async () => {});
    openEngineWorkerStore.mockResolvedValue({ execute, close });
    const options = {
      lazy: true,
      workerModuleUrl: new URL("file:///unselected-workboard-worker.mjs"),
    };
    const store = WorkboardStore.openSqlite(workerModuleUrl, options);
    try {
      await store.ready();
      expect(openEngineWorkerStore).not.toHaveBeenCalled();
      await store.list();
      expect(openEngineWorkerStore).toHaveBeenCalledWith(
        expect.objectContaining({ moduleUrl: workerModuleUrl }),
        undefined,
      );
    } finally {
      await store.close();
    }
    expect(close).toHaveBeenCalledOnce();
  });

  it("drains accepted operations before releasing the broker and seals later calls", async () => {
    const result = createDeferred<WorkboardSqliteResult<unknown>>();
    const { execute, close, stores } = workerFixture();
    execute.mockImplementation(() => result.promise);
    await stores.ready;
    const lookup = stores.cards.lookup("missing");
    const closing = stores.close();
    expect(stores.close()).toBe(closing);
    await expect(stores.cards.lookup("late")).rejects.toThrow("closed");
    expect(close).not.toHaveBeenCalled();
    result.resolve({ ok: true, value: undefined });
    await expect(lookup).resolves.toBeUndefined();
    await closing;
    await stores.close();
    expect(close).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });

  it("retains failed broker cleanup for explicit close retry", async () => {
    const { close, stores } = workerFixture();
    const failure = new Error("broker cleanup failed");
    close.mockRejectedValueOnce(failure);
    await stores.ready;
    await expect(stores.close()).rejects.toBe(failure);
    await expect(stores.boards.entries()).rejects.toThrow("closed");
    await stores.close();
    await stores.close();
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("preserves initial admission failure without inventing a lease to release", async () => {
    const failure = new Error("store initialization failed");
    openEngineWorkerStore.mockRejectedValue(failure);
    const stores = createWorkboardSqliteStores({
      dbPath: "/unused-workboard-lifecycle.sqlite",
      workerModuleUrl,
    });
    await expect(stores.ready).rejects.toBe(failure);
    await expect(stores.cards.entries()).rejects.toBe(failure);
    await stores.close();
    expect(openEngineWorkerStore).toHaveBeenCalledOnce();
  });

  it("preserves aggregate error order, cause, and SQLite fields through V8 serialization", () => {
    const sqlite = Object.assign(new Error("write failed"), {
      name: "StorageFixtureError",
      code: "SQLITE_CONSTRAINT",
      errcode: 19,
      errstr: "constraint failed",
    });
    const failure = new AggregateError(
      [sqlite, new TypeError("cleanup failed")],
      "write and cleanup failed",
      {
        cause: sqlite,
      },
    );
    const encoded: WorkboardSqliteResult<never> = {
      ok: false,
      failure: encodeWorkboardSqliteFailure(failure),
    };
    const transported: WorkboardSqliteResult<never> = deserialize(serialize(encoded));
    let decoded: unknown;
    try {
      unwrapWorkboardSqliteResult(transported);
    } catch (error) {
      decoded = error;
    }
    if (!(decoded instanceof AggregateError)) {
      throw new Error("Expected the transported aggregate failure");
    }
    expect(decoded.message).toBe("write and cleanup failed");
    expect(decoded.errors).toHaveLength(2);
    expect(decoded.errors[0]).toMatchObject({
      name: "StorageFixtureError",
      message: "write failed",
      code: "SQLITE_CONSTRAINT",
      errcode: 19,
      errstr: "constraint failed",
    });
    expect(decoded.errors[1]).toBeInstanceOf(TypeError);
    expect(decoded.errors[1].message).toBe("cleanup failed");
    expect(decoded.cause).toBe(decoded.errors[0]);
  });
});
