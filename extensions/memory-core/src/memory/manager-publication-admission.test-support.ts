import assert from "node:assert/strict";
import { ensureMemoryIndexSchema } from "openclaw/plugin-sdk/memory-core-host-engine-schema";
import { isPostgresSqlConnection } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { getSqliteDatabaseAdmission } from "openclaw/plugin-sdk/sqlite-worker-runtime";

const databasePath = process.argv[2];
assert.ok(databasePath);
const previousVerification = Number(process.argv[3]);
const reopened = openOpenClawAgentDatabase({ agentId: "main", path: databasePath });
try {
  assert.ok(!isPostgresSqlConnection(reopened.db));
  const verification = getSqliteDatabaseAdmission(reopened.db, {
    name: "sqlite.full-verification",
    read: (value) => (typeof value === "number" ? value : undefined),
  });
  assert.equal(typeof verification, "number");
  const integrityChecked = verification !== previousVerification;
  let schemaRebuilt = false;
  for (const method of ["exec", "prepare"] as const) {
    Object.defineProperty(reopened.db, method, {
      value: new Proxy(reopened.db[method], {
        apply(target, receiver, args) {
          schemaRebuilt ||= /\b(?:CREATE|ALTER|DROP)\s+(?:TABLE|INDEX|TRIGGER|VIRTUAL)\b/iu.test(
            args[0],
          );
          return Reflect.apply(target, receiver, args);
        },
      }),
    });
  }
  const { ftsAvailable } = ensureMemoryIndexSchema({
    db: reopened.db,
    cacheEnabled: true,
    ftsEnabled: true,
  });
  console.log(JSON.stringify({ integrityChecked, schemaRebuilt, ftsAvailable }));
} finally {
  reopened.db.close();
}
