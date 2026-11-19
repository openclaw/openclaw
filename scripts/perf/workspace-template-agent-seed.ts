/** Offline synthetic agent-store adapter for the morning replay. No production data. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const GIB = 1024 ** 3;
const PROOF = "morning-agent-seed.json";
export const morningSessionMaintenance = {
  mode: "enforce" as const,
  maxEntries: 20_000,
  pruneAfter: "365d",
  archiveDashboardAfter: "365d",
  maxDiskBytes: 64 * GIB,
  highWaterBytes: 48 * GIB,
};

/** Read only after storage owners have closed; never scan transcript payloads wholesale. */
function inspect(stateDir: string, sessions: number) {
  const databasePath = path.join(stateDir, "agents", "fixture", "agent", "openclaw-agent.sqlite");
  using db = new DatabaseSync(databasePath, { readOnly: true });
  const count = (sql: string) => {
    const value = Object.values(db.prepare(sql).get() ?? {})[0];
    assert(typeof value === "number" && Number.isSafeInteger(value));
    return value;
  };
  const metadata = createHash("sha256");
  let seededSessions = 0;
  for (const row of db
    .prepare(
      "SELECT session_key, current_session_id, entry_json FROM session_nodes WHERE session_key LIKE 'agent:fixture:team-shape-session-%' ORDER BY session_key",
    )
    .iterate()) {
    metadata.update(JSON.stringify(row));
    seededSessions++;
  }
  const payload = createHash("sha256");
  const selected = db.prepare(
    "SELECT session_id, seq, event_json, event_zstd, event_utf8_bytes FROM transcript_events WHERE session_id=? ORDER BY seq LIMIT 16",
  );
  for (const index of new Set([0, Math.floor(sessions / 2), sessions - 1])) {
    for (const row of selected.iterate(`team-shape-session-${index}`)) {
      for (const [key, value] of Object.entries(row)) {
        payload.update(key);
        payload.update(value instanceof Uint8Array ? value : JSON.stringify(value));
      }
    }
  }
  const stats = fs.statSync(databasePath, { bigint: true });
  const pageSize = count("PRAGMA page_size");
  const pageCount = count("PRAGMA page_count");
  return {
    databasePath,
    fileBytes: Number(stats.size),
    allocatedBytes: Number(stats.blocks) * 512,
    physicalIdentity: {
      device: stats.dev.toString(),
      inode: stats.ino.toString(),
      birthtimeNs: stats.birthtimeNs.toString(),
    },
    pageSize,
    pageCount,
    freePages: count("PRAGMA freelist_count"),
    schemaVersion: count("PRAGMA user_version"),
    sessions: count("SELECT count(*) FROM session_nodes"),
    windows: count("SELECT count(*) FROM session_windows"),
    unexpectedSessions: count(
      "SELECT count(*) FROM session_nodes WHERE session_key NOT LIKE 'agent:fixture:team-shape-session-%' AND session_key NOT LIKE 'agent:fixture:morning-%'",
    ),
    transcriptEvents: count("SELECT count(*) FROM transcript_events"),
    seededSessions,
    metadataSha256: metadata.digest("hex"),
    sampledTranscriptSha256: payload.digest("hex"),
  };
}

type SeedProof = { sessions: number; fullScale: boolean; evidence: ReturnType<typeof inspect> };

export function verifyMorningAgentSeed(stateDir: string, addedSessions?: number) {
  const proof: SeedProof = JSON.parse(fs.readFileSync(path.join(stateDir, PROOF), "utf8"));
  const evidence = inspect(stateDir, proof.sessions);
  assert.equal(evidence.seededSessions, proof.sessions);
  assert.equal(evidence.unexpectedSessions, 0);
  assert(evidence.sessions >= proof.evidence.sessions);
  const added = addedSessions ?? evidence.sessions - proof.evidence.sessions;
  assert.equal(evidence.sessions, proof.evidence.sessions + added);
  assert.equal(evidence.windows, proof.evidence.windows + added);
  assert.equal(evidence.transcriptEvents, proof.evidence.transcriptEvents);
  assert.equal(evidence.schemaVersion, proof.evidence.schemaVersion);
  assert.equal(evidence.metadataSha256, proof.evidence.metadataSha256);
  assert.equal(evidence.sampledTranscriptSha256, proof.evidence.sampledTranscriptSha256);
  assert.deepEqual(evidence.physicalIdentity, proof.evidence.physicalIdentity);
  return { fullScale: proof.fullScale, ...evidence };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const { values } = parseArgs({
    options: {
      "state-dir": { type: "string" },
      sessions: { type: "string", default: "10000" },
      "transcript-mib": { type: "string", default: "12096" },
    },
  });
  assert(values["state-dir"], "--state-dir must be a new or empty task-owned directory");
  const stateDir = path.resolve(values["state-dir"]);
  const sessions = Number(values.sessions);
  const transcriptBytes = Number(values["transcript-mib"]) * 1024 ** 2;
  assert(Number.isSafeInteger(sessions) && sessions > 0 && sessions <= 10_000);
  assert(
    Number.isSafeInteger(transcriptBytes) && transcriptBytes > 0 && transcriptBytes <= 48 * GIB,
  );
  fs.mkdirSync(stateDir, { recursive: true });
  assert.deepEqual(fs.readdirSync(stateDir), [], "Refusing to seed existing state");
  Object.assign(process.env, { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_HOME: stateDir });
  const { setRuntimeConfigSnapshot } = await import("../../src/config/runtime-snapshot.js");
  const config = { session: { maintenance: morningSessionMaintenance } };
  setRuntimeConfigSnapshot(config, config);
  const { seedTeamShapeSessions } = await import("./team-shape-sessions.js");
  const agentDb = await import("../../src/state/openclaw-agent-db.js");
  const stateDb = await import("../../src/state/openclaw-state-db.js");
  const { retainOpenClawStateDatabaseForIdle } =
    await import("../../src/state/openclaw-state-db-cache.js");
  const { drainGlobalSingletonLifecycleState } =
    await import("../../src/shared/global-singleton.js");
  const started = performance.now();
  const agent = agentDb.openOpenClawAgentDatabase({ agentId: "fixture" });
  const state = stateDb.openOpenClawStateDatabase();
  const releaseState = retainOpenClawStateDatabaseForIdle(state);
  try {
    // The offline writer owns checkpoints; join periodic work before the bulk load.
    await agent.walMaintenance.stop();
    await state.walMaintenance.stop();
    await seedTeamShapeSessions({
      stateDir,
      agentId: "fixture",
      sessions,
      retainedRuns: 0,
      seed: 2416,
      now: Date.now(),
      transcriptBytes,
    });
  } finally {
    releaseState();
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
    await drainGlobalSingletonLifecycleState();
  }
  const evidence = inspect(stateDir, sessions);
  const fullScale =
    sessions === 10_000 &&
    evidence.fileBytes >= 34 * GIB &&
    evidence.fileBytes <= 36 * GIB &&
    evidence.allocatedBytes >= evidence.fileBytes * 0.95;
  const proof = {
    sessions,
    transcriptBytes,
    fullScale,
    evidence,
    sourceHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    maintenance: morningSessionMaintenance,
    elapsedMs: performance.now() - started,
    memory: process.memoryUsage(),
    resourceUsage: process.resourceUsage(),
  };
  fs.writeFileSync(path.join(stateDir, PROOF), JSON.stringify(proof, null, 2) + "\n");
  console.log(JSON.stringify(proof));
  if (sessions === 10_000) {
    assert(fullScale, "Seed must have 10k sessions and an allocated 34–36 GiB database");
  }
}
