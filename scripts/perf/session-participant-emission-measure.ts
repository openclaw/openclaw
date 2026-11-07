/**
 * Real native participant writes and their post-commit lifecycle notifications.
 * Seeds 10,000 sessions, then rotates count-only contributions through ten hot
 * sessions. One real lifecycle listener counts publications; no simulated socket
 * fanout, Gateway latency, or whole-Gateway savings are claimed.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-participant-emission-measure.ts \
 *   --output .local/participant-candidate --iterations 3000
 * Add --allocation for a separate sampled-allocation pass including collected
 * objects. Alternate fresh baseline/candidate processes. --owner-file <path>
 * substitutes a saved session-accessor.sqlite-participants.native.ts while keeping
 * its imports in this checkout. This workload measures only the native writer.
 * Acceptance: unchanged public participant projection and exact aggregate counts,
 * fewer lifecycle notifications, and no material CPU/allocation regression.
 * Setup, warmup, final-state verification and cleanup are outside the measured
 * window. Results and synthetic state remain in --output for caller-owned cleanup.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    iterations: { type: "string", default: "3000" },
    allocation: { type: "boolean", default: false },
    "owner-file": { type: "string" },
  },
});
assert(values.output, "--output must name a new directory");
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0, "--iterations must be positive");
assert(typeof globalThis.gc === "function", "Run with --expose-gc");
const output = path.resolve(values.output);
mkdirSync(output);
mkdirSync(path.join(output, "home"));
const configPath = path.join(output, "config.json");
process.env = createGatewayBenchEnv(path.join(output, "home"), configPath, {
  startupTrace: false,
  caseEnv: { OPENCLAW_STATE_DIR: path.join(output, "state") },
});
writeFileSync(configPath, JSON.stringify({ plugins: { enabled: false } }));

const ownerUrl = new URL(
  "../../src/config/sessions/session-accessor.sqlite-participants.native.ts",
  import.meta.url,
);
const source = readFileSync(values["owner-file"] ?? ownerUrl, "utf8");
const sourceHash = createHash("sha256").update(source).digest("hex");
const hook = registerHooks({
  load(url, context, nextLoad) {
    return url === ownerUrl.href
      ? { format: "module-typescript", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const owner = await import("../../src/state/openclaw-agent-db.js");
const { writeSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-store.js");
const { recordSessionParticipant } =
  await import("../../src/config/sessions/session-accessor.sqlite-participants.native.js");
const { loadSessionEntry } =
  await import("../../src/config/sessions/session-accessor.sqlite-entry-admitted-read.js");
const { listSessionParticipantsReadOnly } =
  await import("../../src/config/sessions/session-accessor.sqlite-participant-read.js");
const { onSessionLifecycleEvent } = await import("../../src/sessions/session-lifecycle-events.js");

const options = { agentId: "main", env: process.env };
const sessions = 10_000;
const hotSessions = 10;
const warmup = 100;
const participant = { type: "agent" as const, id: "synthetic-peer" };
const sessionKey = (index: number) => `agent:main:participant-emission-${index}`;
let stop: (() => void) | undefined;
try {
  const database = owner.openOpenClawAgentDatabase(options);
  const scopes = Array.from({ length: hotSessions }, (_, index) => ({
    ...options,
    sessionKey: sessionKey(index),
    storePath: database.path,
  }));
  owner.runOpenClawAgentWriteTransaction(() => {
    for (let index = 0; index < sessions; index++) {
      writeSessionEntry(database, sessionKey(index), {
        sessionId: `participant-emission-${index}`,
        updatedAt: 1,
        label: `Synthetic session ${index}`,
        ...(index < hotSessions ? {} : { archivedAt: 2 }),
      });
    }
    for (const scope of scopes) {
      assert.equal(
        recordSessionParticipant(scope, { identity: participant, promptedAt: 1 }),
        "inserted",
      );
    }
  }, options);
  const before = scopes.map((scope) => loadSessionEntry(scope));
  for (const entry of before) {
    assert.deepEqual(entry?.participants, [{ identity: participant }]);
    assert.equal(entry?.participantCount, 1);
  }
  let notifications = 0;
  stop = onSessionLifecycleEvent((event) => {
    if (event.reason === "participants" && event.agentId === "main") {
      notifications++;
    }
  });
  const contribute = (index: number) => {
    const scope = scopes[index % hotSessions];
    assert(scope);
    assert.equal(
      recordSessionParticipant(scope, { identity: participant, promptedAt: 1000 + index }),
      "updated",
    );
  };
  for (let index = 0; index < warmup; index++) {
    contribute(index);
  }
  notifications = 0;
  globalThis.gc();
  const inspector = values.allocation ? new Session() : undefined;
  if (inspector) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoadBefore = loadavg();
  const cpuBefore = process.threadCpuUsage();
  const start = performance.now();
  for (let index = warmup; index < warmup + iterations; index++) {
    contribute(index);
  }
  const wallMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuBefore);
  const hostLoadAfter = loadavg();
  let allocatedBytes: number | undefined;
  if (inspector) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    inspector.disconnect();
    const bytes = (node: HeapProfiler.SamplingHeapProfileNode): number =>
      node.selfSize + node.children.reduce((total, child) => total + bytes(child), 0);
    allocatedBytes = bytes(profile.head);
  }
  assert.deepEqual(
    scopes.map((scope) => loadSessionEntry(scope)),
    before,
  );
  const total = warmup + iterations;
  for (const [index, scope] of scopes.entries()) {
    const contributions = Math.floor((total + hotSessions - 1 - index) / hotSessions);
    assert.deepEqual(listSessionParticipantsReadOnly(scope).get(scope.sessionKey), [
      {
        identity: participant,
        contributionCount: 1 + contributions,
        firstPromptedAt: 1,
        lastPromptedAt: 1000 + index + (contributions - 1) * hotSessions,
      },
    ]);
  }
  const result = {
    mode: values.allocation ? "allocation" : "timing",
    node: process.version,
    sourceHash,
    sessions,
    hotSessions,
    warmup,
    iterations,
    notifications,
    publicProjectionUnchanged: true,
    aggregateCountsVerified: true,
    publicProjectionDigest: createHash("sha256").update(JSON.stringify(before)).digest("hex"),
    wallMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
    allocatedBytes,
    allocatedBytesPerOperation:
      allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
    hostLoadBefore,
    hostLoadAfter,
  };
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  stop?.();
  await owner.closeOpenClawAgentDatabasesAsync();
  const state = await import("../../src/state/openclaw-state-db.js");
  await state.closeOpenClawStateDatabaseAsync();
  const lifecycle = await import("../../src/shared/global-singleton.js");
  await lifecycle.drainGlobalSingletonLifecycleState();
  hook.deregister();
}
