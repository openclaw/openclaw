import assert from "node:assert/strict";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { requireNodeSqlite } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";

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
try {
  const integrityChecked = queries.some((sql) => /\bPRAGMA\s+integrity_check/iu.test(sql));
  queries.length = 0;
  const { ftsAvailable } = ensureMemoryIndexSchema({
    db: reopened.db,
    cacheEnabled: true,
    ftsEnabled: true,
  });
  const schemaRebuilt = queries.some((sql) =>
    /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIRTUAL)\b/iu.test(sql),
  );
  console.log(JSON.stringify({ integrityChecked, schemaRebuilt, ftsAvailable }));
} finally {
  reopened.db.close();
}
