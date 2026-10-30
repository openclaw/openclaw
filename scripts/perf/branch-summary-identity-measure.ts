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
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    owner: { type: "string" },
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
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_HOME = path.join(root, "home");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
const ownerUrl = new URL(
  "../../src/config/sessions/session-accessor.sqlite-branches.worker.ts",
  import.meta.url,
).href;
const wasOwnerReplaced = registerPerfOwnerReplacement(ownerUrl, values.owner);
const { readSessionBranchSnapshot } =
  await import("../../src/config/sessions/session-accessor.sqlite-branches.worker.js");
const { openOpenClawAgentDatabaseReadOnly } =
  await import("../../src/state/openclaw-agent-db-readonly-open.js");
const { executeSqliteQuerySync } = await import("../../src/infra/kysely-sync.js");
const { getSessionKysely } =
  await import("../../src/config/sessions/session-accessor.sqlite-scope-helpers.js");
assert(!values.owner || wasOwnerReplaced(), "Requested baseline source was not loaded");
const opened = openOpenClawAgentDatabaseReadOnly({ agentId: "main", env: process.env });
assert(opened.found, "Synthetic agent database is missing");
const database = opened.database;
const requests = executeSqliteQuerySync(
  database.db,
  getSessionKysely(database.db)
    .selectFrom("session_nodes")
    .select("session_key")
    .orderBy("session_key"),
).rows.map(({ session_key }) => ({ sessionKey: session_key }));
assert.equal(requests.length, fixture.sessionCount, "Synthetic fixture inventory changed");
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
function sampledBytes(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + sampledBytes(child), 0);
}
const inspector = new Session();
try {
  run(1000);
  globalThis.gc?.();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const memoryBefore = process.memoryUsage();
  const cpu = process.threadCpuUsage();
  const started = performance.now();
  const checksum = run(iterations);
  const wallMs = performance.now() - started;
  const used = process.threadCpuUsage(cpu);
  const memoryAfter = process.memoryUsage();
  const allocatedBytes = values.allocations
    ? sampledBytes((await inspector.post("HeapProfiler.stopSampling")).profile.head)
    : undefined;
  console.log(
    JSON.stringify({
      mode: values.allocations ? "allocation" : "timing",
      owner: values.owner ?? ownerUrl,
      node: process.version,
      sessions: fixture.sessionCount,
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
