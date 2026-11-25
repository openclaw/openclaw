import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, it } from "vitest";
import { exercise } from "./store-conformance.test-support.js";
import { createSqliteWorkerBackend } from "./store.worker.js";

const directory = fs.mkdtempSync(
  path.join(process.env.OPENCLAW_TEST_TMPDIR ?? os.tmpdir(), "team-reports-conformance-"),
);
afterAll(() => fs.rmSync(directory, { recursive: true, force: true }));

it("exercises native SQLite worker operations used by PostgreSQL parity", () => {
  const backend = createSqliteWorkerBackend(undefined, {
    databasePath: path.join(directory, "sqlite.sqlite"),
  });
  try {
    exercise(backend);
  } finally {
    backend.close();
  }
});
