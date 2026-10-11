import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, vi } from "vitest";
import { sqliteOnly as test } from "./test/sqlite-only.js";

const { close, configureSqliteConnectionPragmas } = vi.hoisted(() => ({
  close: vi.fn(),
  configureSqliteConnectionPragmas: vi.fn(),
}));

// mock-isolation: Reject at filesystem policy before worker or admission initialization.
vi.mock("openclaw/plugin-sdk/sqlite-worker-runtime", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  return {
    openNodeSqliteDatabase: vi.fn(() => {
      const db = new DatabaseSync(":memory:");
      const closeDatabase = db.close.bind(db);
      vi.spyOn(db, "close").mockImplementation(() => {
        closeDatabase();
        close();
      });
      return db;
    }),
  };
});
vi.mock("openclaw/plugin-sdk/plugin-state-runtime", () => ({
  configureSqliteConnectionPragmas,
}));

import { createWorkboardSqliteKernel } from "./sqlite-store-kernel.js";

describe("Workboard SQLite policy", () => {
  beforeEach(() => {
    close.mockClear();
    configureSqliteConnectionPragmas.mockReset();
  });

  // Injects rejection through the SQLite filesystem-policy and open boundary.
  test("closes a newly opened database when filesystem policy refuses it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-workboard-policy-"));
    const dbPath = path.join(dir, "workboard.sqlite");
    configureSqliteConnectionPragmas.mockImplementation(() => {
      throw new Error("SSHFS is unsupported");
    });

    try {
      expect(() => createWorkboardSqliteKernel(dbPath)).toThrow(/SSHFS/);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
