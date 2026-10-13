import { Worker } from "node:worker_threads";
import {
  borrowOpenClawAgentDatabase,
  readOpenClawAgentDatabaseIdentity,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";

it("keeps no-op and refused publication preparation SQL-free without opening a worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const borrowed = borrowOpenClawAgentDatabase({ agentId: "main" });
    const source = readOpenClawAgentDatabaseIdentity(borrowed);
    const database = new MemoryIndexDatabase(borrowed.db, borrowed.release, false, {
      agentId: "main",
      path: source.filename,
    });
    const sql = observeHostDataSql();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await database.withPublicationGeneration(async () => {});
      const refused = new Error("synthetic preparation refusal");
      await expect(
        database.withPublicationGeneration(async () => {
          throw refused;
        }),
      ).rejects.toBe(refused);
      expect(sql.queries).toEqual([]);
      expect(
        messages.mock.calls.filter(([request]) => {
          const value: unknown = request;
          return (
            value !== null &&
            typeof value === "object" &&
            "type" in value &&
            value.type === "open" &&
            "databasePath" in value &&
            value.databasePath === source.filename
          );
        }),
      ).toEqual([]);
    } finally {
      messages.mockRestore();
      sql.restore();
      borrowed.release();
    }
  });
});
