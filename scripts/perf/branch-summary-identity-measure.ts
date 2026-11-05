/**
 * Uncached branch-snapshot owner CPU and allocation over synthetic Team-shaped storage.
 * Seed once with team-shape-fixture.ts --state-dir .local/branch-fixture --sessions 10000
 * --runs 0 --cron 0 --approvals 0 --projects 0 --transcript-mib 1.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/branch-summary-identity-measure.ts
 *   --root .local/branch-fixture --iterations 3000
 * Add --owner /absolute/base-worker.ts to substitute a saved branch worker source through
 * the current import graph. Alternate base/candidate order. Add --allocations in separate
 * processes; sampled allocations include collected objects and exclude fixture/warmup.
 * Uses one admitted read-only handle; no branch-summary cache or Gateway transport.
 * Compare identical checksums and lower CPU/allocation, with host load reported per arm.
 * --summary-owner substitutes the branch-summary query owner for query preparation comparisons.
 * For branching transcripts, run once with --seed-branches --sessions 32, then measure
 * with --sessions 32. Each selected session gains a 256-message trunk and 40 side tips.
 * Allocation passes sample every 32 KiB, including collected allocations.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { startCollectedHeapSampling, sumSampledHeapBytes } from "../lib/heap-sampling.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    owner: { type: "string" },
    "summary-owner": { type: "string" },
    sessions: { type: "string" },
    "seed-branches": { type: "boolean" },
    iterations: { type: "string", default: "3000" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.root, "--root must name an offline synthetic team-shape fixture");
const root = path.resolve(values.root);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
assert(Number.isSafeInteger(fixture.sessionCount) && fixture.sessionCount >= 10000);
assert.equal(fixture.participantCount, fixture.sessionCount * 3);
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  fallback: 3000,
  min: 1,
  label: "iterations",
});
const selectedSessions = parseStrictIntegerOption({
  raw: values.sessions,
  fallback: fixture.sessionCount,
  min: 1,
  label: "sessions",
});
assert(selectedSessions <= fixture.sessionCount);
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const ownerUrl = new URL(
  "../../src/config/sessions/session-accessor.sqlite-branches.worker.ts",
  import.meta.url,
).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const wasSummaryReplaced = registerPerfOwnerReplacement(
  new URL("../../src/config/sessions/session-accessor.sqlite-branch-summaries.ts", import.meta.url)
    .href,
  values["summary-owner"],
);
const { readSessionBranchSnapshot } =
  await import("../../src/config/sessions/session-accessor.sqlite-branches.worker.js");
const { openOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly-open.js");
const { executeSqliteQuerySync } = await import("../../src/infra/kysely-sync.js");
const { getSessionKysely } =
  await import("../../src/config/sessions/session-accessor.sqlite-scope-helpers.js");
assert(!values.owner || wasOwnerReplaced(), "Requested baseline source was not loaded");
if (values["seed-branches"]) {
  const { runOpenClawAgentWriteTransaction, closeOpenClawAgentDatabasesAsync } =
    await import("../../src/state/openclaw-agent-db.js");
  const { appendTranscriptEventsInTransaction } =
    await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js");
  runOpenClawAgentWriteTransaction(
    (database) => {
      const sessions = executeSqliteQuerySync(
        database.db,
        getSessionKysely(database.db)
          .selectFrom("session_nodes")
          .select(["session_key", "current_session_id"])
          .orderBy("session_key")
          .limit(selectedSessions),
      ).rows;
      for (const row of sessions) {
        assert(row.current_session_id);
        const events = Array.from({ length: 296 }, (_, index) => ({
          type: "message",
          id: `branch-measure-${index}`,
          parentId: index === 0 ? null : `branch-measure-${index < 256 ? index - 1 : 255}`,
          ...(index >= 256 ? { appendMode: "side" } : {}),
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: `Synthetic branch ${index}` },
        }));
        appendTranscriptEventsInTransaction(
          database,
          {
            agentId: "main",
            sessionKey: row.session_key,
            sessionId: row.current_session_id,
          },
          events,
        );
      }
    },
    { agentId: "main", env: process.env },
  );
  const { waitForSessionTranscriptIndexReconcilesInStateDir } =
    await import("../../src/config/sessions/session-transcript-reconcile.js");
  await waitForSessionTranscriptIndexReconcilesInStateDir(root);
  await closeOpenClawAgentDatabasesAsync();
}
const opened = openOpenClawAgentDatabaseReadOnly({ agentId: "main", env: process.env });
assert(opened.found, "Synthetic agent database is missing");
const database = opened.database;
const inventory = executeSqliteQuerySync(
  database.db,
  getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select("session_key")
    .orderBy("session_key"),
).rows.map(({ session_key }) => ({ sessionKey: session_key }));
assert.equal(inventory.length, fixture.sessionCount, "Synthetic fixture inventory changed");
const requests = inventory.slice(0, selectedSessions);
function run(count: number) {
  const checksum = createHash("sha256");
  for (let index = 0; index < count; index++) {
    const snapshot = readSessionBranchSnapshot(database, requests[index % requests.length]!);
    assert.equal(snapshot.status, "ok");
    if (snapshot.status === "ok") {
      checksum.update(JSON.stringify(snapshot.branches));
    }
  }
  return checksum.digest("hex");
}
const inspector = new Session();
try {
  run(1000);
  globalThis.gc?.();
  if (values.allocations) {
    await startCollectedHeapSampling(inspector, 32768);
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = run(iterations);
  assert(
    !values["summary-owner"] || wasSummaryReplaced(),
    "Requested summary source was not loaded",
  );
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocations
    ? sumSampledHeapBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      owner: values.owner ?? ownerUrl,
      summaryOwner: values["summary-owner"],
      node: process.version,
      sessions: fixture.sessionCount,
      selectedSessions,
      participants: fixture.participantCount,
      iterations,
      checksum,
      cpuMs: (used.user + used.system) / 1000,
      wallMs,
      allocatedBytes,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      memoryBefore,
      memoryAfter,
    }),
  );
} finally {
  inspector.disconnect();
  database.close();
}
