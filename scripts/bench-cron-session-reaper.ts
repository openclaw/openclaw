// Standalone real-SQLite proof; run with node --import ./scripts/tsx.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const agentCount = Number(process.argv[2] ?? 632);
assert(Number.isSafeInteger(agentCount) && agentCount > 0 && agentCount <= 1000);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-reaper-proof-"));
process.env.OPENCLAW_HOME = root;
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "state", "openclaw.json");

// Import only after binding every state resolver to disposable synthetic state.
const { replaceSessionEntry, listSessionEntriesReadOnly } =
  await import("../src/config/sessions/session-accessor.js");
const { openOpenClawAgentDatabase, closeOpenClawAgentDatabasesForTest } =
  await import("../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseForTest } = await import("../src/state/openclaw-state-db.js");
const { sweepCronRunSessions } = await import("../src/cron/session-reaper.js");

const now = Date.now();
const hour = 3_600_000;
const targets: Array<{ agentId: string; storePath: string; databasePath: string }> = [];
const warnings: unknown[][] = [];
const log = {
  debug: () => {},
  info: () => {},
  warn: (...args: unknown[]) => warnings.push(args),
  error: (...args: unknown[]) => warnings.push(args),
};

function expectedEntries(agentId: string) {
  return [
    { suffix: "cron:job:run:expiring", sessionId: "expiring", updatedAt: now - 24 * hour + 60_000 },
    { suffix: "cron:job:run:recent", sessionId: "recent", updatedAt: now - hour },
    { suffix: "cron:job", sessionId: "base", updatedAt: now - 48 * hour },
    { suffix: "main", sessionId: "ordinary", updatedAt: now - 48 * hour },
  ].map(({ suffix, ...entry }) => ({ sessionKey: `agent:${agentId}:${suffix}`, entry }));
}

async function sweep(nowMs: number, expectedPruned: number) {
  // Cold process handles, not cold OS page cache. Seeding and verification are untimed.
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  let previous = performance.now();
  let maxTimerDelayMs = 0;
  let timerSamples = 0;
  const timer = setInterval(() => {
    const current = performance.now();
    maxTimerDelayMs = Math.max(maxTimerDelayMs, current - previous - 10);
    previous = current;
    timerSamples += 1;
  }, 10);
  let swept = 0;
  let pruned = 0;
  let elapsedMs: number;
  try {
    await delay(30);
    const start = performance.now();
    // Same sequential await ordering as service/timer-scheduler.ts; no extra yields.
    for (const { agentId, storePath } of targets) {
      const result = await sweepCronRunSessions({
        agentId,
        sessionStorePath: storePath,
        nowMs,
        log,
      });
      swept += Number(result.swept);
      pruned += result.pruned;
    }
    elapsedMs = performance.now() - start;
    // Let a timer blocked by the final sweep report its delay before clearing it.
    await delay(30);
  } finally {
    clearInterval(timer);
  }
  assert.deepEqual(warnings, [], "reaper warnings invalidate the proof");
  assert.equal(swept, agentCount);
  assert.equal(pruned, expectedPruned);
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  let verifiedSurvivors = 0;
  for (const { agentId, storePath } of targets) {
    const actual = listSessionEntriesReadOnly({ agentId, storePath });
    const expected = expectedEntries(agentId).filter(
      ({ entry }) => expectedPruned === 0 || entry.sessionId !== "expiring",
    );
    assert.deepEqual(
      actual.map(({ sessionKey }) => sessionKey).toSorted(),
      expected.map(({ sessionKey }) => sessionKey).toSorted(),
    );
    for (const { sessionKey, entry } of expected) {
      const survivor = actual.find((row) => row.sessionKey === sessionKey)?.entry;
      assert.equal(survivor?.sessionId, entry.sessionId);
      assert.equal(survivor?.updatedAt, entry.updatedAt);
    }
    verifiedSurvivors += actual.length;
  }
  return { elapsedMs, maxTimerDelayMs, timerSamples, swept, pruned, verifiedSurvivors };
}

try {
  for (let index = 0; index < agentCount; index += 1) {
    const agentId = `proof-${index}`;
    const database = openOpenClawAgentDatabase({ agentId });
    const storePath = database.path;
    // Existing cache table supplies ~512 KiB of unrelated data for integrity scans.
    // No custom schema or mocked SQLite/open/accessor implementation is involved.
    database.db
      .prepare(
        "INSERT INTO cache_entries (scope, key, value_json, blob, expires_at, updated_at) VALUES (?, ?, ?, NULL, NULL, ?)",
      )
      .run("reaper-proof", "padding", JSON.stringify({ value: "x".repeat(512 * 1024) }), now);
    for (const { sessionKey, entry } of expectedEntries(agentId)) {
      await replaceSessionEntry({ agentId, storePath, sessionKey }, entry);
    }
    targets.push({ agentId, storePath, databasePath: database.path });
  }
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  const databaseBytes = targets.reduce(
    (sum, target) => sum + fs.statSync(target.databasePath).size,
    0,
  );
  const discovery = await sweep(now, 0);
  // Six minutes crosses both retention and the five-minute reaper throttle.
  const pruning = await sweep(now + 6 * 60_000, agentCount);
  console.log(
    "REAPER_PROOF " +
      JSON.stringify({
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        cpus: os.availableParallelism(),
        agentCount,
        databaseBytes,
        discovery,
        pruning,
      }),
  );
} finally {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
  fs.rmSync(root, { recursive: true, force: true });
}
