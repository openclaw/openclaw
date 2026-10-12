import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { inspectMemoryIndexPresenceInWorker } from "./manager-status-presence.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

it.each(["memory_index_chunks", "chunks"])(
  "reuses the admitted catalog but reads fresh %s presence on every open",
  (table) => {
    const filename = path.join(tempDirs.make("memory-presence-"), "memory.sqlite");
    {
      using db = new DatabaseSync(filename);
      db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
    }
    const observed = observeHostDataSql();
    const schemaQueries = () =>
      observed.queries.filter((sql) =>
        /sqlite_(?:schema|master)|\bPRAGMA\s+(?:user_version|schema_version)\b/iu.test(sql),
      );
    try {
      expect(inspectMemoryIndexPresenceInWorker(filename)).toBe(false);
      expect(schemaQueries().length).toBeGreaterThan(0);
      {
        using db = new DatabaseSync(filename);
        db.exec(`INSERT INTO ${table} VALUES ('new-memory')`);
      }
      observed.queries.length = 0;
      expect(inspectMemoryIndexPresenceInWorker(filename)).toBe(true);
      expect(schemaQueries()).toEqual([]);
      {
        using db = new DatabaseSync(filename);
        db.exec(`DELETE FROM ${table}`);
      }
      observed.queries.length = 0;
      expect(inspectMemoryIndexPresenceInWorker(filename)).toBe(false);
      expect(schemaQueries()).toEqual([]);
    } finally {
      observed.restore();
    }
  },
);
