/** Offline synthetic row-layout probe; run with node --import ./scripts/tsx.mjs. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { prepareTranscriptPayload } from "../../src/config/sessions/transcript-payload.js";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    rows: { type: "string", default: "10000" },
    samples: { type: "string", default: "5" },
  },
});
assert(values.root, "--root must identify an offline session-read-transactions fixture");
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8"));
assert.equal(fixture.format, "openclaw-session-read-transactions-v1");
assert.equal(fixture.target.sessionId, "lane2035-session-00000");
const databasePath = path.join(root, "agents/main/agent/openclaw-agent.sqlite");
assert.equal(fixture.databasePath, databasePath);
const rows = Number(values.rows);
const samples = Number(values.samples);
assert(Number.isSafeInteger(rows) && rows > 0 && rows < fixture.target.events);
assert(Number.isSafeInteger(samples) && samples > 0);
const output = path.join(root, "navigation-pages");
mkdirSync(output, { recursive: true });
const body = Array.from({ length: 1000 }, (_, index) =>
  createHash("sha384").update(`synthetic-navigation-body-${index}`).digest("base64"),
).join("");
const selector = `FROM transcript_events WHERE session_id='lane2035-session-00000'
  AND seq BETWEEN 1 AND ${rows} ORDER BY seq DESC`;
const queries = {
  navigation: `SELECT seq, CASE WHEN navigation_json IS NULL THEN event_json
    ELSE json_extract(navigation_json,'$.navigation') END AS event_json,
    navigation_json IS NOT NULL AS projected ${selector}`,
  payload: `SELECT seq, COALESCE(event_json,event_zstd) AS payload ${selector}`,
  covering: `SELECT seq ${selector}`,
};
const sqlite = (args, input) => {
  const result = spawnSync("sqlite3", args, { input, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || String(result.error));
  return result.stdout;
};
const result = {
  sqlite: sqlite(["--version"]).trim(),
  platform: process.platform,
  node: process.version,
  rows,
  samples,
  cacheKiB: 2048,
  mmapBytes: 0,
  phases: [],
};
for (const phase of ["text-null", "text-navigation", "compressed-navigation"]) {
  const db = new DatabaseSync(databasePath);
  const update = db.prepare(`UPDATE transcript_events
    SET event_json=?,event_zstd=?,event_utf8_bytes=?,navigation_json=?
    WHERE session_id=? AND seq=?`);
  let payloadBytes = 0;
  let navigationBytes = 0;
  const started = performance.now();
  try {
    for (let start = 1; start <= rows; start += 250) {
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let seq = start; seq < Math.min(rows + 1, start + 250); seq++) {
          const event = {
            type: "message",
            id: `event-${String(seq).padStart(6, "0")}`,
            parentId: seq > 1 ? `event-${String(seq - 1).padStart(6, "0")}` : null,
            timestamp: "2026-01-01T00:00:00.000Z",
            message: {
              role: "assistant",
              content: [{ type: "text", text: body }],
              timestamp: 1767225600000,
              __openclaw: { runId: "synthetic-existing-run" },
            },
          };
          const json = JSON.stringify(event);
          const prepared =
            phase === "text-null" ? undefined : prepareTranscriptPayload(db, json, event, "UTF-8");
          if (prepared) {
            assert(prepared.navigation_json && prepared.event_zstd);
          }
          const compressed = phase === "compressed-navigation";
          update.run(
            compressed ? null : json,
            compressed ? prepared.event_zstd : null,
            Buffer.byteLength(json),
            prepared?.navigation_json ?? null,
            fixture.target.sessionId,
            seq,
          );
          payloadBytes += compressed ? prepared.event_zstd.byteLength : Buffer.byteLength(json);
          navigationBytes += Buffer.byteLength(prepared?.navigation_json ?? "");
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    result.pageBytes = db.prepare("PRAGMA page_size").get().page_size;
  } finally {
    db.close();
  }
  const measured = {
    phase,
    databaseBytes: statSync(databasePath).size,
    payloadBytes,
    navigationBytes,
    prepareMs: performance.now() - started,
    loadavg: os.loadavg(),
    reads: [],
  };
  // The fixture is offline and checkpointed. Immutable reads avoid WAL/SHM setup;
  // each CLI connection starts a fresh SQLite cache, not a cold operating-system cache.
  for (let sample = 0; sample < samples; sample++) {
    for (const arm of sample % 2 ? ["A2", "A1"] : ["A1", "A2"]) {
      for (const [kind, query] of Object.entries(queries)) {
        const before = performance.now();
        const stats = sqlite(
          [`${pathToFileURL(databasePath).href}?immutable=1`],
          `.mode off\nPRAGMA mmap_size=0;\nPRAGMA cache_size=-2048;\n.stats on\n${query};\n`,
        );
        const misses = /^Page cache misses:\s+(\d+)/m.exec(stats);
        assert(misses, stats);
        measured.reads.push({
          sample,
          arm,
          kind,
          pageMisses: Number(misses[1]),
          elapsedMs: performance.now() - before,
        });
        writeFileSync(path.join(output, `${phase}-${sample}-${arm}-${kind}.txt`), stats);
      }
    }
  }
  result.phases.push(measured);
  writeFileSync(path.join(output, "results.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(measured));
}
