import assert from "node:assert/strict";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { createSqliteWorkerBackend } from "./store.worker.js";
import { DAY, batchInput, useLogbookFixture } from "./test-fixtures.test-support.js";

const captured = vi.hoisted(() => ({ databases: [] as DatabaseSync[] }));
// Observe the real native owner; schema setup, SQL, rollback, and close remain real.
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

const { makeDir, defer } = useLogbookFixture("logbook-settlement-");

function open() {
  captured.databases.length = 0;
  const dataDir = makeDir();
  const backend = createSqliteWorkerBackend(
    { dataDir },
    { databasePath: path.join(dataDir, "logbook.sqlite") },
  );
  const database = captured.databases[0];
  assert(database);
  let closed = false;
  const close = async () => {
    if (!closed) {
      await backend.close();
      closed = true;
    }
  };
  defer(close);
  return { backend, database, close };
}

it("reports healthy native settlement after a successful operation", () => {
  const { backend } = open();
  backend.execute({ type: "saveStandup", input: { day: DAY, text: "Saved" } });
  expect(() => backend.assertSettled!()).not.toThrow();
  expect(backend.execute({ type: "getStandup", input: { day: DAY } })).toMatchObject({
    text: "Saved",
  });
});

it("rejects an unfinished native transaction until it is rolled back", () => {
  const { backend, database } = open();
  database.exec("BEGIN");
  try {
    expect(() => backend.assertSettled!()).toThrow("unsettled transaction");
  } finally {
    database.exec("ROLLBACK");
  }
  expect(() => backend.assertSettled!()).not.toThrow();
});

it("rejects a closed native owner after asynchronous close completes", async () => {
  const { backend, close } = open();
  await close();
  expect(() => backend.assertSettled!()).toThrow("Logbook database is closed");
});

it("keeps the owner usable after a failed batch rolls back", () => {
  const { backend } = open();
  expect(() => backend.execute({ type: "createBatch", input: batchInput([999]) })).toThrow(
    "999 is missing or already batched",
  );
  expect(() => backend.assertSettled!()).not.toThrow();
  expect(backend.execute({ type: "latestBatch", input: undefined })).toBeNull();
  backend.execute({ type: "saveStandup", input: { day: DAY, text: "After rollback" } });
  expect(backend.execute({ type: "getStandup", input: { day: DAY } })).toMatchObject({
    text: "After rollback",
  });
});
