/**
 * Real-behavior proof for `openclaw sessions cleanup` cron-tombstone sweeping
 * across logical agents that share one physical SQLite session store.
 *
 * Real production code under test (nothing mocked):
 * - `resolveSessionStoreTargets` (src/config/sessions/targets.ts) including the
 *   physical-store dedupe in `dedupeSessionStoreTargetsBySqliteTarget`.
 * - `runSessionsCleanup` (src/config/sessions/cleanup-service.ts) end to end:
 *   preview, lifecycle admission, SQLite write transactions, archive
 *   materialization/publication, and disk-budget enforcement.
 * - `sweepTombstonedCronRunRemnantsForStore` (src/config/sessions/cleanup-tombstones.ts).
 * - Real on-disk SQLite agent databases created under a temp `OPENCLAW_STATE_DIR`.
 *
 * Stubbed: nothing. No vitest, no network, no channel sends. Only the
 * `OPENCLAW_STATE_DIR` env var and the config object are synthesized.
 *
 * Scenarios:
 * 1. `--all-agents` over an exact shared `.sqlite` locator: dedupe collapses
 *    `main` and `ops` onto ONE physical target; both agents' expired cron
 *    placeholders must be swept and archived. This is the regression the P2
 *    review finding described (pre-fix: only the store owner's row was swept).
 * 2. `--agent main` over the same shared store: single-agent isolation is
 *    preserved; `ops` rows survive untouched (the prior round's P1 fix).
 * 3. `--all-agents` over per-agent stores: two independent physical targets,
 *    each agent sweeps only its own store, no cross-store leakage.
 * 4. Post-delete recovery, driven by a REAL SECOND OS PROCESS rather than by
 *    injected faults. A sidecar opens the same SQLite file on its own
 *    connection and, while the sweep is working through one verification
 *    group, (a) rewrites a not-yet-reclaimed placeholder's transcript in place
 *    and (b) references that placeholder immediately after the sweep deletes
 *    it. The sweep's post-delete verification therefore has to put it back,
 *    and what it puts back has to be the transcript its own deletion removed —
 *    not the state the group held when it started. Both halves are the review
 *    findings this round addressed, observed through the shipped cleanup
 *    service with no test double anywhere in the loop.
 *
 * Run: pnpm tsx scripts/proof-117074-tombstone-shared-owners.ts
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runSessionsCleanup } from "../src/config/sessions/cleanup-service.js";
import { replaceSessionEntry } from "../src/config/sessions/session-accessor.js";
import { deleteSessionEntryRows } from "../src/config/sessions/session-accessor.sqlite-entry-store.js";
import { getSessionKysely } from "../src/config/sessions/session-accessor.sqlite-scope.js";
import { replaceTranscriptEventsSync } from "../src/config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveSqliteTargetFromSessionStorePath } from "../src/config/sessions/session-sqlite-target.js";
import { resolveSessionStoreTargets } from "../src/config/sessions/targets.js";
import type { OpenClawConfig } from "../src/config/types.js";
import { executeSqliteQuerySync } from "../src/infra/kysely-sync.js";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../src/state/openclaw-agent-db.js";
import { cleanupSessionStateForTest } from "../src/test-utils/session-state-cleanup.js";

const HOUR_MS = 3_600_000;
let assertions = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  assertions += 1;
  const actualText = JSON.stringify(actual);
  const expectedText = JSON.stringify(expected);
  if (actualText !== expectedText) {
    failures.push(`${label}: expected ${expectedText}, got ${actualText}`);
    console.log(`  FAIL ${label}: expected ${expectedText}, got ${actualText}`);
    return;
  }
  console.log(`  ok   ${label} = ${actualText}`);
}

function makeStateDir(): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "proof-117074-")));
}

const fixtureRoots: string[] = [];

function makeTrackedStateDir(): string {
  const stateDir = makeStateDir();
  fixtureRoots.push(stateDir);
  return stateDir;
}

/**
 * Joins the asynchronous database owners, then removes every fixture root.
 *
 * `closeOpenClawAgentDatabasesForTest` only *starts* resource closure; the
 * reclamation workers a sweep spawned still have to release their durable
 * leases, and that release reopens the shared state database. Removing a root
 * first makes every release fail with ENOENT in a loop that only a wall clock
 * ends. `cleanupSessionStateForTest` is the existing awaited owner: it drains
 * the store writer queues and file locks, then closes the agent handles and the
 * shared state database.
 *
 * It runs once, after the last scenario, because the drain it performs is
 * process-wide. Draining between scenarios would leave every later scenario
 * measuring a cold store rather than the steady state this harness reports.
 */
async function releaseFixtureRoots(): Promise<void> {
  for (const stateDir of fixtureRoots) {
    await cleanupSessionStateForTest({ stateDir });
  }
  closeOpenClawAgentDatabasesForTest();
  for (const stateDir of fixtureRoots) {
    fs.rmSync(stateDir, { recursive: true, force: true });
  }
  fixtureRoots.length = 0;
}

function openStore(storePath: string, agentId: string) {
  const resolved = resolveSqliteTargetFromSessionStorePath(storePath, { agentId });
  if (!resolved.path) {
    throw new Error(`no sqlite path resolved for ${storePath}`);
  }
  return openOpenClawAgentDatabase({ agentId: resolved.agentId ?? agentId, path: resolved.path });
}

/**
 * Seeds one canonical expired cron retained-history placeholder: a real session
 * entry plus transcript is written through the accessor, then the readable
 * entry rows are deleted so only the intentionally empty placeholder remains.
 */
async function seedExpiredCronPlaceholder(params: {
  storePath: string;
  ownerAgentId: string;
  sessionKey: string;
  sessionId: string;
  ageMs: number;
}): Promise<void> {
  await replaceSessionEntry(
    { sessionKey: params.sessionKey, storePath: params.storePath },
    { sessionId: params.sessionId, updatedAt: Date.now() },
  );
  replaceTranscriptEventsSync(
    { sessionKey: params.sessionKey, sessionId: params.sessionId, storePath: params.storePath },
    [{ type: "session", id: params.sessionId, content: "cron run transcript" }],
  );
  const database = openStore(params.storePath, params.ownerAgentId);
  // The readable entry still owns a retained transcript window here, so
  // `deleteSessionEntryRows` reaches `writeSessionEntrySnapshots`, which
  // refuses to run outside an entry transaction. Seeding through the real
  // transaction owner is what the production delete path does.
  runOpenClawAgentWriteTransaction((writer) => deleteSessionEntryRows(writer, params.sessionKey), {
    agentId: database.agentId,
    path: database.path,
  });
  const updatedAt = Date.now() - params.ageMs;
  const db = getSessionKysely(database.db);
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_windows")
      .set({ updated_at: updatedAt })
      .where("session_key", "=", params.sessionKey),
  );
  // Separate statements on purpose: one combined `.set({ updated_at, entry_valid })`
  // does not persist `entry_valid`, and the canonical placeholder predicate
  // requires `entry_valid === -1`.
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ updated_at: updatedAt })
      .where("session_key", "=", params.sessionKey),
  );
  executeSqliteQuerySync(
    database.db,
    db
      .updateTable("session_nodes")
      .set({ entry_valid: -1 })
      .where("session_key", "=", params.sessionKey),
  );
}

function countNodes(storePath: string, ownerAgentId: string, sessionKey: string): number {
  const database = openStore(storePath, ownerAgentId);
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("session_nodes").select("session_key").where("session_key", "=", sessionKey),
  ).rows.length;
}

function countTranscriptEvents(storePath: string, ownerAgentId: string, sessionId: string): number {
  const database = openStore(storePath, ownerAgentId);
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db.selectFrom("transcript_events").select("session_id").where("session_id", "=", sessionId),
  ).rows.length;
}

function countArchives(storePath: string, ownerAgentId: string, sessionId: string): number {
  const database = openStore(storePath, ownerAgentId);
  const db = getSessionKysely(database.db);
  return executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("session_transcript_archives")
      .select("archive_name")
      .where("session_id", "=", sessionId),
  ).rows.length;
}

function twoAgentConfig(store?: string): OpenClawConfig {
  return {
    agents: { list: [{ id: "main" }, { id: "ops" }] },
    ...(store ? { session: { store } } : {}),
  } as unknown as OpenClawConfig;
}

function totalSweptRemnants(
  summaries: readonly { tombstoneRemnants?: { removedNodes: number } | null }[],
): number {
  return summaries.reduce(
    (total, summary) => total + (summary.tombstoneRemnants?.removedNodes ?? 0),
    0,
  );
}

async function scenarioAllAgentsSharedStore(): Promise<void> {
  console.log("\n[1] --all-agents over an exact shared .sqlite locator");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "shared.sqlite");
  const cfg = twoAgentConfig(storePath);

  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:main:cron:job-1:run:run-1",
    sessionId: "main-cron-session",
    ageMs: 48 * HOUR_MS,
  });
  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:ops:cron:job-2:run:run-2",
    sessionId: "ops-cron-session",
    ageMs: 48 * HOUR_MS,
  });

  const targets = resolveSessionStoreTargets(cfg, { allAgents: true });
  check("dedupe collapses both agents to one physical target", targets.length, 1);
  check("selected target owner", targets[0]?.agentId, "main");

  check(
    "main placeholder seeded",
    countNodes(storePath, "main", "agent:main:cron:job-1:run:run-1"),
    1,
  );
  check(
    "ops placeholder seeded",
    countNodes(storePath, "main", "agent:ops:cron:job-2:run:run-2"),
    1,
  );

  const result = await runSessionsCleanup({
    cfg,
    opts: { allAgents: true, enforce: true },
  });
  check("applied one store summary", result.appliedSummaries.length, 1);
  check("swept remnants across selected owners", totalSweptRemnants(result.appliedSummaries), 2);
  check(
    "main placeholder removed",
    countNodes(storePath, "main", "agent:main:cron:job-1:run:run-1"),
    0,
  );
  check(
    "ops placeholder removed",
    countNodes(storePath, "main", "agent:ops:cron:job-2:run:run-2"),
    0,
  );
  check("main transcript swept", countTranscriptEvents(storePath, "main", "main-cron-session"), 0);
  check("ops transcript swept", countTranscriptEvents(storePath, "main", "ops-cron-session"), 0);
  check("main transcript archived", countArchives(storePath, "main", "main-cron-session"), 1);
  check("ops transcript archived", countArchives(storePath, "main", "ops-cron-session"), 1);
}

async function scenarioSingleAgentSharedStore(): Promise<void> {
  console.log("\n[2] --agent main over the same shared store keeps ops isolated");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "shared.sqlite");
  const cfg = twoAgentConfig(storePath);

  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:main:cron:job-1:run:run-1",
    sessionId: "main-cron-session",
    ageMs: 48 * HOUR_MS,
  });
  await seedExpiredCronPlaceholder({
    storePath,
    ownerAgentId: "main",
    sessionKey: "agent:ops:cron:job-2:run:run-2",
    sessionId: "ops-cron-session",
    ageMs: 48 * HOUR_MS,
  });

  const result = await runSessionsCleanup({
    cfg,
    opts: { agent: "main", enforce: true },
  });
  check("swept exactly the requested owner", totalSweptRemnants(result.appliedSummaries), 1);
  check(
    "main placeholder removed",
    countNodes(storePath, "main", "agent:main:cron:job-1:run:run-1"),
    0,
  );
  check(
    "ops placeholder preserved",
    countNodes(storePath, "main", "agent:ops:cron:job-2:run:run-2"),
    1,
  );
  check(
    "ops transcript preserved",
    countTranscriptEvents(storePath, "main", "ops-cron-session"),
    1,
  );
  check("ops not archived", countArchives(storePath, "main", "ops-cron-session"), 0);
}

async function scenarioAllAgentsPerAgentStores(): Promise<void> {
  console.log("\n[3] --all-agents over per-agent stores sweeps each store once");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const cfg = twoAgentConfig();
  const mainStorePath = path.join(stateDir, "agents", "main", "sessions", "sessions.json");
  const opsStorePath = path.join(stateDir, "agents", "ops", "sessions", "sessions.json");

  await seedExpiredCronPlaceholder({
    storePath: mainStorePath,
    ownerAgentId: "main",
    sessionKey: "agent:main:cron:job-1:run:run-1",
    sessionId: "main-cron-session",
    ageMs: 48 * HOUR_MS,
  });
  await seedExpiredCronPlaceholder({
    storePath: opsStorePath,
    ownerAgentId: "ops",
    sessionKey: "agent:ops:cron:job-2:run:run-2",
    sessionId: "ops-cron-session",
    ageMs: 48 * HOUR_MS,
  });

  const targets = resolveSessionStoreTargets(cfg, { allAgents: true });
  check("per-agent stores stay distinct targets", targets.length, 2);

  const result = await runSessionsCleanup({
    cfg,
    opts: { allAgents: true, enforce: true },
  });
  check("applied two store summaries", result.appliedSummaries.length, 2);
  check("swept one remnant per store", totalSweptRemnants(result.appliedSummaries), 2);
  check(
    "main placeholder removed",
    countNodes(mainStorePath, "main", "agent:main:cron:job-1:run:run-1"),
    0,
  );
  check(
    "ops placeholder removed",
    countNodes(opsStorePath, "ops", "agent:ops:cron:job-2:run:run-2"),
    0,
  );
}

/**
 * The external writer, as a standalone process with no access to this module.
 *
 * It talks to the store through `node:sqlite` and raw SQL only, so nothing in
 * the sweep's own process can coordinate with it: no shared module state, no
 * injected hook, no patched prototype. That is the point — the review asked for
 * recovery evidence that is not a mocked fault, and the only honest way to
 * produce a post-delete reference is for a separate writer to actually create
 * one while the sweep runs.
 *
 * Sequence, each step gated on observable store state rather than on a sleep:
 * 1. Wait until the first placeholder's node row is gone. That proves the
 *    sweep has finished preparing its verification group and started deleting.
 * 2. Rewrite the LAST placeholder's transcript event in place. It is still
 *    present at this point — six more archive encodes stand between it and its
 *    own deletion — and the rewrite changes nothing the sweep's revalidation
 *    compares, so the delete still proceeds and removes the rewritten row.
 * 3. Wait until that last placeholder's node row is gone, then insert a plain
 *    session row that references its transcript generation.
 */
const EXTERNAL_WRITER_SOURCE = String.raw`
import { DatabaseSync } from "node:sqlite";
const [databasePath, firstKey, lateKey, lateSessionId, marker, referenceKey] =
  process.argv.slice(2);
if (!databasePath) {
  throw new Error("external writer requires the database path as its first argument");
}
const database = new DatabaseSync(databasePath);
database.exec("PRAGMA busy_timeout = 20000");
const idle = new Int32Array(new SharedArrayBuffer(4));
const pause = () => Atomics.wait(idle, 0, 0, 5);
const absent = (key) =>
  database.prepare("SELECT COUNT(*) AS present FROM session_nodes WHERE session_key = ?").get(key)
    .present === 0;
function waitForAbsence(key, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (absent(key)) {
      return true;
    }
    pause();
  }
  return false;
}
function write(statement, bindings) {
  const deadline = Date.now() + 20000;
  for (;;) {
    try {
      return database.prepare(statement).run(...bindings);
    } catch (error) {
      if (Date.now() >= deadline || !/SQLITE_BUSY|database is locked/i.test(String(error))) {
        throw error;
      }
      pause();
    }
  }
}
if (!waitForAbsence(firstKey, 120000)) {
  console.log("external-writer: timed out waiting for the first reclaim");
  process.exit(2);
}
console.log("external-writer: first placeholder reclaimed; rewriting the last one's transcript");
const rewritten = write(
  "UPDATE transcript_events SET event_json = ? WHERE session_id = ?",
  [JSON.stringify({ type: "session", id: lateSessionId, content: marker }), lateSessionId],
);
console.log("external-writer: transcript rows rewritten = " + rewritten.changes);
if (rewritten.changes !== 1) {
  process.exit(3);
}
if (!waitForAbsence(lateKey, 120000)) {
  console.log("external-writer: timed out waiting for the late reclaim");
  process.exit(4);
}
write(
  "INSERT INTO session_nodes (session_key, current_session_id, entry_json, updated_at) VALUES (?, ?, '{}', ?)",
  [referenceKey, lateSessionId, Date.now()],
);
console.log("external-writer: reference created for " + lateSessionId);
database.close();
`;

async function scenarioExternalPostDeleteRecovery(): Promise<void> {
  console.log("\n[4] a separate process references a reclaimed placeholder after its delete");
  const stateDir = makeTrackedStateDir();
  process.env.OPENCLAW_STATE_DIR = stateDir;
  const storePath = path.join(stateDir, "recovery.sqlite");
  const cfg = twoAgentConfig(storePath);
  // One full verification group: the sweep snapshots and reclaims these in a
  // single group, which is the window the external writer works inside.
  const placeholders = 8;
  const keyOf = (index: number) => `agent:main:cron:job-${index}:run:run-${index}`;
  const sessionIdOf = (index: number) => `recovery-cron-session-${index}`;
  for (let index = 0; index < placeholders; index += 1) {
    await seedExpiredCronPlaceholder({
      storePath,
      ownerAgentId: "main",
      sessionKey: keyOf(index),
      sessionId: sessionIdOf(index),
      ageMs: 48 * HOUR_MS,
    });
  }
  const lateIndex = placeholders - 1;
  const marker = "cron run transcript (rewritten by another process)";
  const databasePath = openStore(storePath, "main").path;
  check("placeholders seeded", countNodes(storePath, "main", keyOf(lateIndex)), 1);

  // Written out as a module file rather than passed to `node -e`: with `-e`
  // there is no script path in `process.argv`, so the first real argument lands
  // at index 1 and a `slice(2)` read silently drops it. A file keeps the
  // ordinary argv contract, and the writer stays a separate program.
  const writerPath = path.join(stateDir, "external-writer.mjs");
  fs.writeFileSync(writerPath, EXTERNAL_WRITER_SOURCE);
  const writer = spawn(
    process.execPath,
    [
      writerPath,
      databasePath,
      keyOf(0),
      keyOf(lateIndex),
      sessionIdOf(lateIndex),
      marker,
      "agent:main:direct:external-post-delete-reference",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let writerOutput = "";
  writer.stdout.on("data", (chunk: Buffer) => {
    writerOutput += chunk.toString();
  });
  writer.stderr.on("data", (chunk: Buffer) => {
    writerOutput += chunk.toString();
  });
  const writerExit = new Promise<number>((resolve) => {
    writer.on("exit", (code) => resolve(code ?? -1));
  });

  const result = await runSessionsCleanup({ cfg, opts: { allAgents: true, enforce: true } });
  const writerCode = await writerExit;
  for (const line of writerOutput.trim().split("\n")) {
    console.log(`  | ${line}`);
  }
  check("external writer completed", writerCode, 0);

  // The sweep reports seven removals out of eight candidates: the eighth was
  // deleted and then put back, so it is subtracted from the applied counts
  // rather than reported as reclaimed.
  check("candidates considered", result.appliedSummaries[0]?.tombstoneRemnants?.candidates, 8);
  check("remnants reported removed", totalSweptRemnants(result.appliedSummaries), placeholders - 1);
  check(
    "externally referenced placeholder restored",
    countNodes(storePath, "main", keyOf(lateIndex)),
    1,
  );
  check(
    "its transcript generation restored",
    countTranscriptEvents(storePath, "main", sessionIdOf(lateIndex)),
    1,
  );
  // The recovery assertion that only an in-transaction preimage can satisfy:
  // the content put back is the content this sweep's own deletion removed.
  const restored = openStore(storePath, "main");
  const restoredEvent = executeSqliteQuerySync(
    restored.db,
    getSessionKysely(restored.db)
      .selectFrom("transcript_events")
      .select("event_json")
      .where("session_id", "=", sessionIdOf(lateIndex)),
  ).rows[0];
  check(
    "restored transcript carries the externally rewritten content",
    (restoredEvent?.event_json ?? "").includes(marker),
    true,
  );
  for (let index = 0; index < lateIndex; index += 1) {
    check(
      `unreferenced placeholder ${index} stays reclaimed`,
      countNodes(storePath, "main", keyOf(index)),
      0,
    );
  }
}

async function main(): Promise<void> {
  await scenarioAllAgentsSharedStore();
  await scenarioSingleAgentSharedStore();
  await scenarioAllAgentsPerAgentStores();
  await scenarioExternalPostDeleteRecovery();
  // Teardown belongs here, not per scenario: joining the owners is what lets
  // every fixture root be removed without a lease chasing a deleted file.
  await releaseFixtureRoots();
  console.log(`\nassertions: ${assertions}, failures: ${failures.length}`);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.log(`FAILED: ${failure}`);
    }
    throw new Error(`${failures.length} runtime assertion(s) failed`);
  }
  console.log("All runtime assertions passed.");
}

await main();
