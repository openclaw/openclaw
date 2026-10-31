import assert from "node:assert/strict";
import fs from "node:fs";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { closeOpenClawAgentDatabasesAsync } from "openclaw/plugin-sdk/sqlite-runtime-testing";

const databasePath = process.argv[2];
assert.ok(databasePath);
const queries: string[] = [];
const sqlite = requireNodeSqlite();
const { DatabaseSync } = sqlite;
sqlite.DatabaseSync = class extends DatabaseSync {
  override prepare(sql: string) {
    if (this.location() === databasePath) {
      queries.push(sql);
    }
    return super.prepare(sql);
  }

  override exec(sql: string) {
    if (this.location() === databasePath) {
      queries.push(sql);
    }
    return super.exec(sql);
  }
};

const reopened = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
let result;
try {
  queries.length = 0;
  const { ftsAvailable } = ensureMemoryIndexSchema({
    db: reopened.db,
    cacheEnabled: true,
    ftsEnabled: true,
  });
  const schemaRebuilt = queries.some((sql) =>
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIRTUAL)\b/iu.test(sql),
  );
  const matches = reopened.db
    .prepare(
      "SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'replacement'",
    )
    .all();
  result = { schemaRebuilt, ftsAvailable, matches };
} finally {
  await closeOpenClawAgentDatabasesAsync();
}
console.log(JSON.stringify({ ...result, sealPresent: fs.existsSync(`${databasePath}.seal`) }));
