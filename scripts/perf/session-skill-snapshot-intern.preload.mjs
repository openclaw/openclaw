// Synthetic fixture seeding + aggregate residency for team-shape-stress.ts.
// Use --sessions 10000 --output "$PWD/.local/<new-directory>"
// --gateway-preload "$PWD/scripts/perf/session-skill-snapshot-intern.preload.mjs".
// Run against already-built revisions. No source runtime imports or retained graphs.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

if (isMainThread) {
  const allowedRoot = realpathSync(fileURLToPath(new URL("../../.local/", import.meta.url)));
  assert(process.env.OPENCLAW_STATE_DIR, "Isolated synthetic state directory is required");
  const stateDirectory = realpathSync(process.env.OPENCLAW_STATE_DIR);
  const relative = path.relative(allowedRoot, stateDirectory);
  assert(
    relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    "State must be under this lane's .local directory",
  );
  const summary = JSON.parse(
    readFileSync(path.join(stateDirectory, "team-shape-summary.json"), "utf8"),
  );
  assert.equal(summary.format, "openclaw-team-shape-v1");
  assert(summary.sessionCount >= 10000, "Fixture must contain at least 10,000 synthetic sessions");
  const config = JSON.parse(readFileSync(path.join(stateDirectory, "openclaw.json"), "utf8"));
  assert.equal(config.gateway.bind, "loopback");
  assert(config.gateway.port >= 40000 && config.gateway.port <= 65535, "Isolated port required");
  const output = path.join(stateDirectory, "buf318-skills-residency.jsonl");
  const seeded = path.join(stateDirectory, "buf318-skills-seeded.json");
  const poolKey = Symbol.for("openclaw.sessionActorReplicas");

  function seed() {
    assert(
      globalThis[poolKey] === undefined,
      "Seeding must precede Gateway runtime initialization",
    );
    const filename = realpathSync(
      path.join(stateDirectory, "agents", "main", "agent", "openclaw-agent.sqlite"),
    );
    const databaseRelative = path.relative(stateDirectory, filename);
    assert(
      databaseRelative && !databaseRelative.startsWith("..") && !path.isAbsolute(databaseRelative),
      "Database escaped synthetic state",
    );
    const database = new DatabaseSync(filename);
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('session_nodes', 'session_entry_snapshots')",
        )
        .all();
      assert.equal(tables.length, 2, "Expected existing session schema");
      const rows = database
        .prepare(
          "SELECT session_key FROM session_nodes WHERE current_session_id GLOB 'team-shape-session-[0-9]*' ORDER BY session_key LIMIT 10000",
        )
        .all();
      assert.equal(rows.length, 10000, "Expected 10,000 synthetic fixture entries");
      const inventories = Array.from({ length: 4 }, (_, version) =>
        JSON.stringify({
          prompt: `Synthetic inventory ${version}\n${"Skill instructions. ".repeat(512)}`,
          skills: Array.from({ length: 40 }, (_skill, index) => ({
            name: `synthetic-${index}`,
            requiredEnv: [`SYNTHETIC_${index}`],
            source: { filePath: `/synthetic/skills/${index}/SKILL.md` },
          })),
          version,
        }),
      );
      const insert = database.prepare(
        "INSERT INTO session_entry_snapshots (session_key, field, value_json) VALUES (?, 'skillsSnapshot', ?) ON CONFLICT(session_key, field) DO UPDATE SET value_json = excluded.value_json",
      );
      // Small sequential batches; existing snapshot-revision triggers remain active.
      for (let offset = 0; offset < rows.length; offset += 100) {
        database.exec("BEGIN IMMEDIATE");
        try {
          for (let index = offset; index < Math.min(rows.length, offset + 100); index++) {
            insert.run(rows[index].session_key, inventories[index % inventories.length]);
          }
          database.exec("COMMIT");
        } catch (error) {
          database.exec("ROLLBACK");
          throw error;
        }
      }
      const receipt = {
        kind: "synthetic-skills-seed",
        at: Date.now(),
        sessions: rows.length,
        contentSets: inventories.length,
        uniqueSerializedBytes: inventories.reduce((sum, json) => sum + Buffer.byteLength(json), 0),
        totalSerializedBytes: inventories.reduce(
          (sum, json) => sum + Buffer.byteLength(json) * 2500,
          0,
        ),
      };
      writeFileSync(seeded, JSON.stringify(receipt), { flag: "wx", mode: 0o600 });
      appendFileSync(output, `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    } finally {
      database.close();
    }
  }

  if (!existsSync(seeded)) {
    seed();
  }

  function sample() {
    // All graph references are local to this call; only aggregate scalars escape.
    const pool = globalThis[poolKey];
    const identities = new Set();
    const content = new Map();
    let entries = 0;
    let references = 0;
    let serializedBytesByReference = 0;
    let serializedBytesByIdentity = 0;
    if (pool?.cells instanceof Map) {
      for (const cell of pool.cells.values()) {
        const entry = cell.snapshot?.entry ?? cell.entry?.entry;
        if (!entry) {
          continue;
        }
        entries++;
        const snapshot = entry.skillsSnapshot;
        if (!snapshot) {
          continue;
        }
        references++;
        const json = JSON.stringify(snapshot);
        const bytes = Buffer.byteLength(json);
        serializedBytesByReference += bytes;
        if (!identities.has(snapshot)) {
          identities.add(snapshot);
          serializedBytesByIdentity += bytes;
          content.set(createHash("sha256").update(json).digest("hex"), bytes);
        }
      }
    }
    appendFileSync(
      output,
      `${JSON.stringify({
        kind: "replica-residency",
        at: Date.now(),
        cells: pool?.cells?.size ?? 0,
        residentEntries: entries,
        snapshotReferences: references,
        snapshotIdentities: identities.size,
        snapshotContentSets: content.size,
        serializedBytesByReference,
        serializedBytesByIdentity,
        serializedBytesByContent: [...content.values()].reduce((sum, bytes) => sum + bytes, 0),
        replicaEstimatedBytes: pool?.bytes ?? 0,
        memory: process.memoryUsage(),
        scope:
          "Existing actor replica only; serialized bytes are payload size, not V8 retained bytes. No full-store reads or artificial retention.",
      })}\n`,
      { mode: 0o600 },
    );
  }

  sample();
  setInterval(sample, 10000).unref();
  process.once("exit", sample);
}
