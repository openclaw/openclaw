import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Exercise candidate recovery only after the intact published updater has settled. */
export async function provePublishedDriverScopedRestore({
  packageRoot,
  state,
  env,
  artifacts,
  run,
  writeJson,
}) {
  const candidateAgentSchemaVersion = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  ).openclaw.schemaVersions.agent;
  assert(
    Number.isSafeInteger(candidateAgentSchemaVersion) && candidateAgentSchemaVersion > 26,
    "Candidate agent schema must advance the v26 fixture",
  );
  const config = JSON.parse(fs.readFileSync(env.OPENCLAW_CONFIG_PATH, "utf8"));
  const schema = fs.readFileSync(
    new URL("../../../../test/fixtures/sqlite/openclaw-agent-schema-v26.sql", import.meta.url),
    "utf8",
  );
  const agents = ["scoped-a-healthy", "scoped-z-broken"];
  const targets = agents.map((agentId) => ({
    agentId,
    pathname: path.join(state, "agents", agentId, "agent", "openclaw-agent.sqlite"),
  }));
  for (const { agentId, pathname } of targets) {
    const workspace = path.join(state, "workspaces", agentId);
    fs.mkdirSync(workspace, { recursive: true });
    config.agents.entries[agentId] = { workspace };
    fs.mkdirSync(path.dirname(pathname), { recursive: true });
    const database = new DatabaseSync(pathname);
    try {
      database.exec(schema);
      database.exec("PRAGMA user_version = 26;");
      database
        .prepare(`INSERT INTO schema_meta
        (meta_key, role, schema_version, agent_id, created_at, updated_at)
        VALUES ('primary', 'agent', 26, ?, 1, 1)`)
        .run(agentId);
      database.exec(`
        INSERT INTO context_engine_turn_outbox
          (rowid, advancement_key, engine_id, session_id, payload_json, created_at)
        VALUES (40, 'z-first', 'test', 'retained', '{"state":"ready"}', 1),
               (91, 'a-second', 'test', 'retained', '{"state":"blocked"}', 2);
        INSERT INTO cache_entries (scope, key, value_json, updated_at)
        VALUES ('scoped-restore-proof', 'unrelated', '"before"', 1);
        ANALYZE;
      `);
      if (agentId === agents[1]) {
        // Preserve v26 admission, then fail the real v27 CREATE TABLE in its transaction.
        database.exec(
          "CREATE TABLE context_engine_turn_outbox_sequence_migration (blocked INTEGER);",
        );
      }
    } finally {
      database.close();
    }
  }
  fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, `${JSON.stringify(config)}\n`);
  const [healthy, broken] = targets;
  const before = inspect(healthy.pathname);
  const failed = await run(
    "scoped-migration-expected-failure",
    "openclaw",
    ["doctor", "--fix", "--non-interactive"],
    true,
  );
  assert.notEqual(failed.exitCode, 0, "Malformed outbox unexpectedly migrated");
  assert.match(
    fs.readFileSync(path.join(artifacts, "scoped-migration-expected-failure.stdout"), "utf8") +
      fs.readFileSync(path.join(artifacts, "scoped-migration-expected-failure.stderr"), "utf8"),
    /context_engine_turn_outbox_sequence_migration/,
    "Doctor failed outside the intended outbox migration",
  );
  const committed = inspect(healthy.pathname);
  assert.equal(
    committed.version,
    candidateAgentSchemaVersion,
    "Healthy member did not commit before the failure",
  );
  assert.deepEqual(committed.outbox, before.outbox);
  assert.equal(inspect(broken.pathname).version, 26, "Failed member escaped its transaction");
  const backups = fs
    .readdirSync(path.dirname(healthy.pathname))
    .filter((name) => name.endsWith(".scoped.bak"));
  assert.equal(backups.length, 1, "Expected one scoped checkpoint for the committed member");
  const backupPath = path.join(path.dirname(healthy.pathname), backups[0]);
  const database = new DatabaseSync(healthy.pathname);
  try {
    database.exec(`UPDATE cache_entries SET value_json = '"later owner write"'
      WHERE scope = 'scoped-restore-proof';`);
  } finally {
    database.close();
  }
  await run("scoped-migration-restore", "openclaw", [
    "database",
    "restore-migration-backup",
    backupPath,
    healthy.pathname,
    "--json",
  ]);
  const restored = inspect(healthy.pathname);
  assert.equal(restored.version, 26);
  assert.deepEqual(restored.outbox, before.outbox);
  assert.equal(restored.unrelated, '"later owner write"');
  writeJson("scoped-restore", {
    phase: "post-update-candidate-maintenance",
    failureExitCode: failed.exitCode,
    migratedVersion: committed.version,
    restoredVersion: restored.version,
    outboxRows: restored.outbox.length,
    unrelatedWritePreserved: true,
    backupPath,
    backupBytes: fs.statSync(backupPath).size,
  });
}

function inspect(pathname) {
  const database = new DatabaseSync(pathname, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get().user_version;
    const columns = version === 26 ? "rowid AS enqueue_sequence, *" : "*";
    return {
      version,
      outbox: database
        .prepare(`SELECT ${columns} FROM context_engine_turn_outbox ORDER BY enqueue_sequence`)
        .all(),
      unrelated: database
        .prepare("SELECT value_json FROM cache_entries WHERE scope = 'scoped-restore-proof'")
        .get().value_json,
    };
  } finally {
    database.close();
  }
}
