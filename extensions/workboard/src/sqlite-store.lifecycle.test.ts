import { setImmediate } from "node:timers/promises";
import { deserialize, serialize } from "node:v8";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { SqliteWorkerError } from "openclaw/plugin-sdk/sqlite-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkboardSqliteOperations } from "./sqlite-store-contract.js";
import {
  encodeWorkboardSqliteFailure,
  unwrapWorkboardSqliteResult,
  type WorkboardSqliteResult,
} from "./sqlite-store-errors.js";

const { openSqliteWorkerStore } = vi.hoisted(() => ({ openSqliteWorkerStore: vi.fn() }));
vi.mock(import("openclaw/plugin-sdk/sqlite-runtime"), async (importOriginal) => ({
  ...(await importOriginal()),
  openSqliteWorkerStore,
}));

import { createWorkboardSqliteStores } from "./sqlite-store.js";

const workerModuleUrl = new URL("./sqlite-store.worker.ts", import.meta.url);

type Request = {
  [K in keyof WorkboardSqliteOperations]: { type: K; input: WorkboardSqliteOperations[K]["input"] };
}[keyof WorkboardSqliteOperations];

function workerFixture() {
  const execute = vi.fn<(request: Request) => Promise<WorkboardSqliteResult<unknown>>>();
  const release = vi.fn(async () => {});
  openSqliteWorkerStore.mockResolvedValue({ execute, close: release });
  const stores = createWorkboardSqliteStores({
    dbPath: "/unused-workboard-lifecycle.sqlite",
    workerModuleUrl,
  });
  return { execute, release, stores };
}

beforeEach(() => openSqliteWorkerStore.mockReset());

describe("Workboard SQLite facade cleanup", () => {
  it("retains its broker reference until the same connection closes successfully", async () => {
    const lookupResult = createDeferred<WorkboardSqliteResult<unknown>>();
    const firstClose = createDeferred<WorkboardSqliteResult<unknown>>();
    const failure = new SqliteWorkerError("connection cleanup failed", "unavailable");
    const { execute, release, stores } = workerFixture();
    execute
      .mockResolvedValueOnce({ ok: true, value: { connection: 7, dataVersion: 4 } })
      .mockImplementationOnce(() => lookupResult.promise)
      .mockImplementationOnce(() => firstClose.promise)
      .mockResolvedValueOnce({ ok: true, value: undefined });
    await expect(stores.ready).resolves.toBe(4);
    const lookup = stores.cards.lookup("missing");
    const closing = stores.close();
    const rejected = expect(closing).rejects.toBe(failure);
    expect(stores.close()).toBe(closing);
    await setImmediate();
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      { type: "connection.open", input: undefined },
      { type: "cards.lookup", input: { connection: 7, args: ["missing"] } },
    ]);
    expect(release).not.toHaveBeenCalled();
    lookupResult.resolve({ ok: true, value: undefined });
    await expect(lookup).resolves.toBeUndefined();
    firstClose.resolve({ ok: false, failure: { error: failure } });
    await rejected;
    expect(release).not.toHaveBeenCalled();
    await expect(stores.cards.lookup("late")).rejects.toThrow("closed");

    const retry = stores.close();
    expect(stores.close()).toBe(retry);
    await retry;
    await stores.close();
    expect(release).toHaveBeenCalledOnce();
    expect(openSqliteWorkerStore).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      { type: "connection.open", input: undefined },
      { type: "cards.lookup", input: { connection: 7, args: ["missing"] } },
      { type: "connection.close", input: { connection: 7 } },
      { type: "connection.close", input: { connection: 7 } },
    ]);
  });

  it("retries broker release without repeating a completed connection close", async () => {
    const failure = new Error("broker cleanup failed");
    const { execute, release, stores } = workerFixture();
    execute
      .mockResolvedValueOnce({ ok: true, value: { connection: 7, dataVersion: 4 } })
      .mockResolvedValueOnce({ ok: true, value: undefined });
    release.mockRejectedValueOnce(failure);
    await stores.ready;
    await expect(stores.close()).rejects.toBe(failure);
    await expect(stores.boards.entries()).rejects.toThrow("closed");
    await stores.close();
    await stores.close();
    expect(release).toHaveBeenCalledTimes(2);
    expect(openSqliteWorkerStore).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      { type: "connection.open", input: undefined },
      { type: "connection.close", input: { connection: 7 } },
    ]);
  });

  it.each(
    (["closed", "unavailable", "outcome-unknown"] as const).flatMap((code) =>
      (["current", "previous"] as const).map((graph) => ({ code, graph })),
    ),
  )(
    "delegates terminal $code from the $graph module graph without replay",
    async ({ code, graph }) => {
      const retired = createDeferred<void>();
      const cleanupFailure = new Error("broker retirement incomplete");
      class PreviousGraphSqliteWorkerError extends Error {
        readonly code: string;
        constructor(failureCode: string) {
          super("transport stopped");
          this.code = failureCode;
        }
      }
      const failure =
        graph === "current"
          ? new SqliteWorkerError("transport stopped", code)
          : new PreviousGraphSqliteWorkerError(code);
      expect(failure instanceof SqliteWorkerError).toBe(graph === "current");
      const { execute, release, stores } = workerFixture();
      execute
        .mockResolvedValueOnce({ ok: true, value: { connection: 7, dataVersion: 4 } })
        .mockRejectedValueOnce(failure);
      release.mockRejectedValueOnce(cleanupFailure).mockImplementationOnce(() => retired.promise);
      await stores.ready;
      await expect(stores.close()).rejects.toBe(cleanupFailure);
      let settled = false;
      const retry = stores.close().then(() => {
        settled = true;
      });
      await setImmediate();
      expect(settled).toBe(false);
      expect(execute).toHaveBeenCalledTimes(2);
      retired.resolve();
      await retry;
      await stores.close();
      expect(release).toHaveBeenCalledTimes(2);
      expect(execute).toHaveBeenCalledTimes(2);
      expect(openSqliteWorkerStore).toHaveBeenCalledOnce();
    },
  );

  it.each(["overloaded", "SQLITE_BUSY", undefined])(
    "retains nonterminal rejection %s for explicit retry",
    async (code) => {
      const failure = Object.assign(new Error("close refused"), { code });
      const { execute, release, stores } = workerFixture();
      execute
        .mockResolvedValueOnce({ ok: true, value: { connection: 7, dataVersion: 4 } })
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({ ok: true, value: undefined });
      await stores.ready;
      await expect(stores.close()).rejects.toBe(failure);
      expect(release).not.toHaveBeenCalled();
      await stores.close();
      expect(execute.mock.calls.slice(1).map(([request]) => request)).toEqual([
        { type: "connection.close", input: { connection: 7 } },
        { type: "connection.close", input: { connection: 7 } },
      ]);
      expect(release).toHaveBeenCalledOnce();
    },
  );

  it("reclaims a failed open while preserving its original initialization error", async () => {
    const openingFailure = new Error("connection initialization failed");
    const cleanupFailure = new Error("retained connection cleanup failed");
    const { execute, release, stores } = workerFixture();
    execute
      .mockResolvedValueOnce({
        ok: false,
        failure: { error: openingFailure, cleanupConnection: 7 },
      })
      .mockResolvedValueOnce({ ok: false, failure: { error: cleanupFailure } })
      .mockResolvedValueOnce({ ok: true, value: undefined });
    await expect(stores.ready).rejects.toBe(openingFailure);
    await expect(stores.cards.entries()).rejects.toBe(openingFailure);
    expect(release).not.toHaveBeenCalled();
    await expect(stores.close()).rejects.toBe(cleanupFailure);
    expect(release).not.toHaveBeenCalled();
    await expect(stores.ready).rejects.toBe(openingFailure);
    await expect(stores.close()).resolves.toBeUndefined();
    await expect(stores.close()).resolves.toBeUndefined();
    await expect(stores.cards.entries()).rejects.toBe(openingFailure);
    expect(release).toHaveBeenCalledOnce();
    expect(openSqliteWorkerStore).toHaveBeenCalledOnce();
    expect(execute.mock.calls.map(([request]) => request)).toEqual([
      { type: "connection.open", input: undefined },
      { type: "connection.close", input: { connection: 7 } },
      { type: "connection.close", input: { connection: 7 } },
    ]);
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
