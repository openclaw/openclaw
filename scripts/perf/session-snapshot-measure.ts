/**
 * Session snapshot owner: rich synthetic rows, one snapshot per event (not per client).
 * node --import ./scripts/tsx.mjs scripts/perf/session-snapshot-measure.ts --iterations 5000
 * --owner <saved-session-event-payload.ts> loads the pinned base with original imports.
 * Alternate base/candidate for five pairs. --max-bytes <bytes/snapshot> is an exact
 * V8 allocation regression budget, set from the base before measuring a candidate.
 * Warmup/imports and byte-parity checks are outside the measured owner loop.
 * JSON SHA-256 covers full event frames with 65 divergent recipient sequence stamps;
 * this is synthetic wire parity, not socket throughput or authorization evidence.
 * Acceptance: identical wire hashes, fewer allocated bytes, no material CPU regression.
 * No forced GC or tracing. GC/heap/load are context; no whole-Gateway claims.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { setImmediate as nextTurn } from "node:timers/promises";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import type { buildGatewaySessionSnapshot as BuildSnapshot } from "../../src/gateway/session-event-payload.js";
import { startGatewayBenchDiagnostics } from "../lib/gateway-bench-diagnostics.ts";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    iterations: { type: "string", default: "5000" },
    "max-bytes": { type: "string" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const maxBytes = values["max-bytes"] === undefined ? undefined : Number(values["max-bytes"]);
assert(maxBytes === undefined || (Number.isFinite(maxBytes) && maxBytes > 0));
const ownerUrl = new URL("../../src/gateway/session-event-payload.ts", import.meta.url);
const source = readFileSync(values.owner ?? ownerUrl, "utf8");
let loaded = false;
const hooks = registerHooks({
  load(url, context, next) {
    if (url !== ownerUrl.href) {
      return next(url, context);
    }
    loaded = true;
    return { format: "module", source: stripTypeScriptTypes(source), shortCircuit: true };
  },
});
const { buildGatewaySessionSnapshot } = await import("../../src/gateway/session-event-payload.js");
hooks.deregister();
assert(loaded);
const fixtures: Parameters<typeof BuildSnapshot>[0][] = Array.from({ length: 64 }, (_, index) => ({
  agentId: "main",
  sessionRow: Object.freeze({
    key: `agent:main:synthetic-${index}`,
    sessionId: `synthetic-${index}`,
    kind: "direct",
    updatedAt: 1_800_000_000_000,
    label: `Synthetic session ${index}`,
    displayName: "Synthetic 🦞 session",
    participants: [],
    participantCount: 0,
    archived: index % 4 === 0,
    pinned: index % 3 === 0,
    unread: true,
    lastActivityAt: 1_800_000_000_000,
    status: "done",
    startedAt: 1_799_999_999_000,
    endedAt: 1_800_000_000_000,
    runtimeMs: 1000,
    totalTokens: 1200,
    totalTokensFresh: index % 3 === 0,
    contextTokens: 1400,
    inputTokens: 1000,
    outputTokens: 200,
    modelProvider: "synthetic",
    model: "mock-model",
    activeModel: "mock-fallback",
    activeModelProvider: "synthetic",
    lastAssistantMessage: { text: "Synthetic result ".repeat(30), timestamp: 1_800_000_000_000 },
    thinkingLevel: "high",
    thinkingDefault: "medium",
    thinkingLevels: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
    ],
    subagentRunState: "historical",
    hasActiveSubagentRun: false,
  }),
  activeRunState: { active: true, runIds: [`run-${index}`] },
  ...(index % 2 === 0
    ? {
        lifecycle: true,
        event: {
          runId: `run-${index}`,
          sessionId: `synthetic-${index}`,
          seq: 1,
          ts: 1_800_000_001_000,
          stream: "lifecycle",
          data: { phase: "start", startedAt: 1_800_000_001_000 },
        },
      }
    : {}),
}));
const wire = createHash("sha256");
for (const fixture of fixtures) {
  const payload = buildGatewaySessionSnapshot(fixture);
  for (let client = 0; client < 65; client++) {
    wire.update(
      JSON.stringify({ type: "event", event: "sessions.changed", payload, seq: client + 1 }),
    );
  }
}
let checksum = 0;
function run(count: number) {
  for (let index = 0; index < count; index++) {
    const snapshot = buildGatewaySessionSnapshot(fixtures[index % fixtures.length]!);
    checksum += snapshot.hasActiveRun === true ? 1 : 0;
  }
}
run(1000);
await nextTurn();
const loadBefore = loadavg();
const memoryBefore = process.memoryUsage();
const stop = startGatewayBenchDiagnostics();
const allocatedBefore = getHeapStatistics().total_allocated_bytes;
assert(Number.isFinite(allocatedBefore), "Requires exact V8 allocation counters");
const cpuBefore = process.threadCpuUsage();
const started = performance.now();
run(iterations);
const wallMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuBefore);
const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
await nextTurn();
await nextTurn();
const diagnostics = stop();
assert.equal(checksum, iterations + 1000);
console.log(
  JSON.stringify({
    iterations,
    ownerSha256: createHash("sha256").update(source).digest("hex"),
    wireSha256: wire.digest("hex"),
    wireFrames: fixtures.length * 65,
    wallMs,
    threadCpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes,
    bytesPerSnapshot: allocatedBytes / iterations,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
    loadBefore,
    loadAfter: loadavg(),
    diagnostics,
  }),
);
assert(
  maxBytes === undefined || allocatedBytes / iterations <= maxBytes,
  `Allocation budget exceeded: ${allocatedBytes / iterations} > ${maxBytes} bytes/snapshot`,
);
