import assert from "node:assert/strict";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it, vi } from "vitest";
import { createWorkboardSqliteKernel } from "./sqlite-store-kernel.js";
import { createSqliteWorkerBackend } from "./sqlite-store.worker.js";

const captured = vi.hoisted(() => ({ databases: [] as DatabaseSync[] }));
// Keep real schema setup, queries, rollback, and close while retaining the native handle.
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/sqlite-worker-runtime")>();
  return {
    ...actual,
    openNodeSqliteDatabase: (...args: Parameters<typeof actual.openNodeSqliteDatabase>) => {
      const database = actual.openNodeSqliteDatabase(...args);
      captured.databases.push(database);
      return database;
    },
  };
});

const closers: Array<() => void | Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    try {
      await Promise.all(closers.splice(0).map(async (close) => close()));
    } finally {
      vi.restoreAllMocks();
      cleanup();
    }
  }),
);
const databasePath = () => path.join(tempDirs.make("workboard-settlement-"), "workboard.sqlite");

function openBackend() {
  const backend = createSqliteWorkerBackend(undefined, { databasePath: databasePath() });
  closers.push(() => backend.close());
  return backend;
}

it("checks native transaction settlement and closed state in the kernel", () => {
  captured.databases.length = 0;
  const kernel = createWorkboardSqliteKernel(databasePath());
  closers.push(kernel.close);
  const database = captured.databases[0];
  assert(database);
  expect(() => kernel.assertSettled()).not.toThrow();
  database.exec("BEGIN");
  try {
    expect(() => kernel.assertSettled()).toThrow("unsettled transaction");
  } finally {
    database.exec("ROLLBACK");
  }
  expect(() => kernel.assertSettled()).not.toThrow();
  kernel.close();
  expect(() => kernel.assertSettled()).toThrow("Workboard database is closed");
});

it("keeps the owner usable after an operation failure rolls back", () => {
  const backend = openBackend();
  const register = (createdAt: number) =>
    backend.execute({
      type: "boards.register",
      input: {
        args: ["board", { version: 1, board: { id: "board", createdAt, updatedAt: 1 } }],
      },
    });
  // STRICT integer storage rejects this value after the transaction has started.
  expect(register(0.5)).toMatchObject({ ok: false });
  expect(() => backend.assertSettled!()).not.toThrow();
  expect(register(1)).toEqual({ ok: true, value: undefined });
  expect(backend.execute({ type: "boards.lookup", input: { args: ["board"] } })).toMatchObject({
    ok: true,
    value: { board: { id: "board", createdAt: 1 } },
  });
});

it("detects a closed connection even when execution returns a handled failure", async () => {
  const backend = openBackend();
  await backend.close();
  expect(backend.execute({ type: "boards.lookup", input: { args: ["board"] } })).toMatchObject({
    ok: false,
  });
  expect(() => backend.assertSettled!()).toThrow("Workboard database is closed");
});
