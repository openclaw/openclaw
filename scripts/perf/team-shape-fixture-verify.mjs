// Offline synthetic fixture verification through the measured build's database owners.
import assert from "node:assert/strict";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const source = realpathSync(process.argv[2]);
const state = realpathSync(process.env.OPENCLAW_STATE_DIR);
const summary = JSON.parse(readFileSync(path.join(state, "team-shape-summary.json"), "utf8"));
assert.equal(summary.format, "openclaw-team-shape-v1");
assert(summary.profile.startsWith("team-shape-"));
const config = JSON.parse(readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
const fromSource = (name) => import(pathToFileURL(path.join(source, name)).href);
const [
  { listAgentIds },
  owner,
  { assertSqliteIntegrity },
  { readSqliteDatabaseIntegrityVerification },
  stateOwner,
] = await Promise.all([
  fromSource("src/agents/agent-roster.ts"),
  fromSource("src/state/openclaw-agent-db.ts"),
  fromSource("src/infra/sqlite-integrity.ts"),
  fromSource("src/infra/sqlite-database-admission.ts"),
  fromSource("src/state/openclaw-state-db.ts"),
]);
const results = [];
for (const agentId of listAgentIds(config)) {
  const startedAt = Date.now();
  const database = owner.openOpenClawAgentDatabase({ agentId });
  const relative = path.relative(state, realpathSync(database.path));
  assert(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  const reused = readSqliteDatabaseIntegrityVerification(database.db) !== undefined;
  if (!reused) {
    const verified = assertSqliteIntegrity(database.db, `synthetic fixture ${agentId}`);
    assert.equal(verified.integrityCheck, "ok");
  }
  await owner.closeOpenClawAgentDatabasesAsync();
  const result = {
    agentId,
    startedAt,
    elapsedMs: Date.now() - startedAt,
    integrityCheck: "full+foreign-keys",
    verification: reused ? "reused-native-proof" : "fresh-full-scan",
    close: "native owner",
  };
  results.push(result);
  console.log(`OLDGEN_VERIFIED_CLEAN ${JSON.stringify(result)}`);
}
await stateOwner.closeOpenClawStateDatabaseAsync();
writeFileSync(
  path.join(state, "offline-integrity-proof.json"),
  JSON.stringify({ source, results }, null, 2) + "\n",
  { flag: "wx", mode: 0o600 },
);
