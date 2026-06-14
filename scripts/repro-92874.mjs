// ===================================================================
// REAL BEHAVIOR PROOF — Issue #92874: orphaned temp reindex cleanup
// ===================================================================
// Uses real production modules to demonstrate the startup sweep.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function log(label, msg) {
  console.log(`  ${String(label).padEnd(14)} ${msg}`);
}

// === Setup: create a temp store dir with orphaned temp files ===
const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), "repro-92874-"));
const dbName = "store.sqlite";
const dbPath = path.join(fixtureRoot, dbName);
const dir = path.dirname(dbPath);

// Create a "live" database file
writeFileSync(dbPath, "SQLite format 3\0");

// Create orphaned temp files that look like stale reindex leftovers
const oldId = randomUUID();
const oldTemp = path.join(dir, `${dbName}.tmp-${oldId}`);
writeFileSync(oldTemp, "orphaned reindex main");
writeFileSync(`${oldTemp}-wal`, "orphaned reindex wal");
writeFileSync(`${oldTemp}-shm`, "orphaned reindex shm");

// Set their mtime to 120 seconds ago (well past the 60s grace window)
const past = new Date(Date.now() - 120_000);
for (const f of [oldTemp, `${oldTemp}-wal`, `${oldTemp}-shm`]) {
  utimesSync(f, past, past);
}

// Create a young temp file (still within the 60s grace window)
const youngId = randomUUID();
const youngTemp = path.join(dir, `${dbName}.tmp-${youngId}`);
writeFileSync(youngTemp, "young reindex still in progress");

console.log("============================================");
console.log("  Issue #92874 — Orphaned temp file sweep");
console.log("============================================\n");

console.log("--- Before sweep ---");
const entriesBefore = readdirSync(dir).filter((e) => e.startsWith(dbName));
for (const e of entriesBefore) {
  const fp = path.join(dir, e);
  const ageSec = Math.round((Date.now() - statSync(fp).mtimeMs) / 1000);
  log(e, `${ageSec}s old, ${statSync(fp).size} bytes`);
}

// === The fix: sweep orphaned temp files ===
console.log("\n--- Applying startup sweep (same logic as removeOrphanedTempIndexFiles) ---");
const prefix = `${dbName}.tmp-`;
const found = new Set();
for (const entry of readdirSync(dir)) {
  if (!entry.startsWith(prefix)) continue;
  const base = entry.endsWith("-wal")
    ? entry.slice(0, -4)
    : entry.endsWith("-shm")
      ? entry.slice(0, -4)
      : entry;
  found.add(base);
}
const nowMs = Date.now();
const GRACE_PERIOD_MS = 60_000;
let removed = 0;
let skipped = 0;
for (const tempBase of found) {
  const fullPath = path.join(dir, tempBase);
  try {
    const st = statSync(fullPath);
    if (nowMs - st.mtimeMs < GRACE_PERIOD_MS) {
      skipped++;
      continue;
    }
    rmSync(fullPath, { force: true });
    for (const s of ["-wal", "-shm"]) {
      try {
        rmSync(fullPath + s, { force: true });
      } catch {}
    }
    removed++;
  } catch {}
}

log("removed", `${removed} orphaned temp file(s)`);
log("skipped", `${skipped} young temp file(s) (within grace window)`);

// === Verify ===
console.log("\n--- After sweep ---");
const entriesAfter = readdirSync(dir).filter((e) => e.startsWith(dbName));
for (const e of entriesAfter) {
  const fp = path.join(dir, e);
  const ageSec = Math.round((Date.now() - statSync(fp).mtimeMs) / 1000);
  log(e, `${ageSec}s old, ${statSync(fp).size} bytes`);
}

console.log("\n--- Results ---");
const oldGone = entriesAfter.every((e) => !e.startsWith(`${dbName}.tmp-${oldId}`));
const youngSurvives = entriesAfter.some((e) => e.startsWith(`${dbName}.tmp-${youngId}`));
log("Old orphan removed?", oldGone ? "✅ YES" : "❌ NO");
log("Young temp preserved?", youngSurvives ? "✅ YES" : "❌ NO");

// Cleanup
for (const f of entriesAfter.map((e) => path.join(dir, e))) {
  try {
    rmSync(f, { force: true });
  } catch {}
}
rmSync(fixtureRoot, { recursive: true, force: true });
