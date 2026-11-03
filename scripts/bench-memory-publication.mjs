#!/usr/bin/env node
// Focused companion to the frozen Gateway workload; synthetic data only.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

if (process.argv.includes("--help")) {
  console.log(`Usage: MEMORY_PUBLICATION_OUT=<fresh-directory> node --import ./scripts/tsx.mjs scripts/bench-memory-publication.mjs
Preload the frozen SQL observer via NODE_OPTIONS and set SQLMEASURE_OUT to the
same output directory. Phases distinguish setup, admission, publication, and prune.`);
  process.exit(0);
}
assert(process.env.MEMORY_PUBLICATION_OUT, "Set MEMORY_PUBLICATION_OUT");
const output = path.resolve(process.env.MEMORY_PUBLICATION_OUT);
fs.mkdirSync(output, { recursive: true });
process.env.OPENCLAW_STATE_DIR = path.join(output, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(output, "openclaw.json");
const phase = (name) => fs.writeFileSync(path.join(output, "phase"), name);
const load = (file) => import(pathToFileURL(path.join(process.cwd(), file)).href);
phase("setup");
const { installDatabaseProcessRole } = await load("src/infra/database-engine/admission-scope.ts");
installDatabaseProcessRole("cli-oneshot");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesAsync } = await load(
  "src/state/openclaw-agent-db.ts",
);
const { openNodeSqliteDatabase } = await load("src/infra/node-sqlite.ts");
const { bindSqliteWorkerBackend } = await load(
  "extensions/memory-core/src/memory/manager-publication.worker.ts",
);
const { readMemoryShadowIdentity, readMemoryConnectionPragmas } = await load(
  "extensions/memory-core/src/memory/manager-shadow-task.ts",
);
const target = openOpenClawAgentDatabase({
  agentId: "fixture",
  path: path.join(output, "agent.sqlite"),
});
const backend = bindSqliteWorkerBackend(
  { kind: "agent" },
  { databasePath: target.path, database: target.db, admit() {} },
);
const schema = { cacheEnabled: true, ftsEnabled: true };
const execute = (owner, type, input) => {
  const result = owner.execute({ type, input });
  assert.equal(result.ok, true, result.error?.message);
  return result;
};
let shadow;
let shadowBackend;
try {
  phase("existing-target-admission");
  execute(backend, "schema.admit", schema);
  phase("setup");
  const sourcePath = path.join(output, "shadow.sqlite");
  shadow = openNodeSqliteDatabase(sourcePath);
  const sourceIdentity = readMemoryShadowIdentity(sourcePath);
  shadowBackend = bindSqliteWorkerBackend(
    {
      fileIdentity: sourceIdentity,
      pragmas: readMemoryConnectionPragmas(shadow, "Invalid fixture pragmas"),
    },
    { databasePath: sourcePath, database: shadow, admit() {} },
  );
  phase("fresh-shadow-admission");
  const admitted = execute(shadowBackend, "schema.admit", { ...schema, fresh: true });
  phase("setup");
  shadow.exec(`INSERT INTO memory_index_sources(path, source, hash, mtime, size)
    VALUES ('memory/fixture.md', 'memory', 'fixture', 1, 1);
    INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('fixture', 'memory/fixture.md', 'memory', 1, 1, 'fixture',
              'synthetic', 'cobalt telescope', X'', 1);`);
  const revision = target.db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
  phase("full-index-publication");
  execute(backend, "database.publish", {
    sourcePath,
    sourceIdentity,
    sourceSchema: admitted.searchSchema,
    metaKey: "memory_index_meta_v1",
    expectedRevision: revision.revision,
    state: {
      vector: { enabled: false, available: false },
      fts: { enabled: true, available: true },
    },
  });
  phase("mandatory-cache-recount");
  execute(backend, "cache.prune", { maxEntries: 2, recount: true });
  phase("verify");
  assert.equal(target.db.prepare("SELECT COUNT(*) AS n FROM memory_embedding_cache").get().n, 0);
  assert.equal(
    target.db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH 'cobalt'",
      )
      .get().n,
    1,
  );
  console.log("Memory publication fixture passed");
} finally {
  phase("cleanup");
  shadowBackend?.close();
  shadow?.close();
  backend.close();
  await closeOpenClawAgentDatabasesAsync();
}
