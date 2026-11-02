// Isolated synthetic replay: node --import ./scripts/tsx.mjs scripts/perf/doctor-session-manifests.ts
// Positional arguments: source count (32), historical manifests (4), moves per manifest (2000).
// Compare base/candidate serially with fresh HOME/OPENCLAW_STATE_DIR beneath .artifacts/.
import assert from "node:assert/strict";
import fs from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";

const artifactRoot = path.resolve(".artifacts");
const stateDir = process.env.OPENCLAW_STATE_DIR;
for (const directory of [stateDir, process.env.HOME]) {
  assert(directory && path.resolve(directory).startsWith(`${artifactRoot}${path.sep}`));
}
assert(stateDir);
assert(!fs.existsSync(path.join(stateDir, "openclaw.json")), "Use fresh synthetic state.");
const [sourceCount = 32, manifestCount = 4, movesPerManifest = 2000] = process.argv
  .slice(2)
  .map(Number);
for (const count of [sourceCount, manifestCount, movesPerManifest]) {
  assert(Number.isSafeInteger(count) && count > 0);
}
const { doctorCommand } = await import("../../src/commands/doctor.js");
const { runDoctorSessionSqlite } = await import("../../src/commands/doctor-session-sqlite.js");
const { recordDeferredPluginMigrations } =
  await import("../../src/infra/deferred-plugin-migrations.js");
const { readMigrationArtifactIdentity } =
  await import("../../src/infra/session-sqlite-migration-artifact.js");
const {
  createSessionSqliteMigrationRun,
  readSessionSqliteMigrationManifest,
  writeSessionSqliteMigrationManifest,
} = await import("../../src/infra/session-sqlite-migration-manifest.js");
const { openOpenClawStateDatabase, closeOpenClawStateDatabaseAsync } =
  await import("../../src/state/openclaw-state-db.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { ExitError } = await import("../../src/runtime.js");

const sessionsDir = path.join(stateDir, "agents/main/sessions");
const storePath = path.join(sessionsDir, "sessions.json");
const archiveDir = path.join(stateDir, "agents/main/session-sqlite-import-archive");
const cfg = { agents: { entries: { main: {} } }, gateway: { mode: "local" as const } };
fs.mkdirSync(sessionsDir, { recursive: true });
fs.mkdirSync(archiveDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, "openclaw.json"), JSON.stringify(cfg));
const entries = Object.fromEntries(
  Array.from({ length: sourceCount }, (_, index) => {
    const sessionId = `synthetic-${index}`;
    const sessionFile = `${sessionId}.jsonl`;
    fs.writeFileSync(
      path.join(sessionsDir, sessionFile),
      `${JSON.stringify({ type: "session", version: 3, id: sessionId })}\n`,
    );
    return [`agent:main:${index}`, { sessionId, sessionFile, updatedAt: 20 }];
  }),
);
fs.writeFileSync(storePath, JSON.stringify(entries));
const close = async () => {
  await closeOpenClawAgentDatabasesAsync();
  await closeOpenClawStateDatabaseAsync();
};
try {
  openOpenClawStateDatabase({ env: process.env });
  await recordDeferredPluginMigrations({
    env: process.env,
    pending: [
      {
        pluginId: "synthetic-plugin",
        reason: "Synthetic unavailable plugin",
        command: "openclaw doctor --fix",
      },
    ],
  });
  const initial = await runDoctorSessionSqlite({
    cfg,
    env: process.env,
    mode: "import",
    allAgents: true,
  });
  assert.equal(initial.totals.importedEntries, sourceCount);
  const target = { agentId: "main", storePath, sqlitePath: initial.targets[0]!.sqlitePath };
  const identity = readMigrationArtifactIdentity(storePath);
  const indexArchive = path.join(archiveDir, "synthetic-index.json");
  fs.renameSync(storePath, indexArchive);
  let manifestBytes = 0;
  for (let manifestIndex = 0; manifestIndex < manifestCount; manifestIndex++) {
    const run = createSessionSqliteMigrationRun(process.env, [target]);
    const artifact = {
      identity,
      classification: "protected" as const,
      reason: "Synthetic migration evidence. ".repeat(12),
      dependencies: [],
      disposal: { state: "retained" as const },
    };
    run.manifest.targets[0]!.plannedMoves = [
      { kind: "legacy-store", sourcePath: storePath, archivePath: indexArchive, artifact },
      ...Array.from({ length: movesPerManifest }, (_, moveIndex) => ({
        kind: "transcript" as const,
        sourcePath: path.join(sessionsDir, `missing-${manifestIndex}-${moveIndex}.jsonl`),
        archivePath: path.join(archiveDir, `missing-${manifestIndex}-${moveIndex}.jsonl`),
        artifact,
      })),
    ];
    writeSessionSqliteMigrationManifest(run);
    assert(readSessionSqliteMigrationManifest(run.manifestPath));
    manifestBytes += fs.statSync(run.manifestPath).size;
  }
  for (const entry of Object.values(entries)) {
    fs.appendFileSync(path.join(sessionsDir, entry.sessionFile), "\n");
  }
  await close();
  const originalRead = fs.readFileSync;
  let parses = 0;
  let archiveParses = 0;
  let recoveryParses = 0;
  // Every counted read enters the real schema parser; no manifest or database behavior is mocked.
  fs.readFileSync = function (...args: Parameters<typeof fs.readFileSync>) {
    if (
      String(args[0]).includes("/session-sqlite-migration-runs/") &&
      String(args[0]).endsWith(".json")
    ) {
      parses++;
      const stack = new Error().stack ?? "";
      if (stack.includes("collectArchivedSources")) {
        archiveParses++;
        if (stack.includes("rebuildDeferredPluginSessionSourceIndex")) {
          recoveryParses++;
        }
      }
    }
    return Reflect.apply(originalRead, fs, args);
  } as typeof fs.readFileSync;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    await doctorCommand(undefined, {
      repair: true,
      yes: true,
      nonInteractive: true,
      sessionSqlite: "import",
      sessionSqliteAllAgents: true,
    });
  } catch (error) {
    if (!(error instanceof ExitError) || error.code !== 0) {
      throw error;
    }
  } finally {
    fs.readFileSync = originalRead;
    console.log(
      JSON.stringify({
        sourceCount,
        manifestCount,
        movesPerManifest,
        manifestBytes,
        parses,
        archiveParses,
        recoveryParses,
        wallMs: performance.now() - start,
        cpu: process.cpuUsage(cpuStart),
        hostLoad: loadavg(),
      }),
    );
  }
} finally {
  await close();
}
