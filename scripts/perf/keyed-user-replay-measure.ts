/**
 * Measure receipt adoption only: 64 retained managers, 10,240 synthetic transcript
 * entries, 5,000 historical keyed-user receipts. The reload is already prepared;
 * this excludes SQLite, model execution and Gateway load. Correctness lives in the
 * manager and prompt-admission integration regressions.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/keyed-user-replay-measure.ts
 * Add --owner-file src/agents/sessions/.session-manager-append.base.ts for a saved
 * sibling baseline; --allocation enables a separate 1 KiB sampled allocation pass.
 * Compare rejection/success counts and CPU/allocation; no whole-Gateway claim.
 */
import assert from "node:assert/strict";
import type { HeapProfiler } from "node:inspector";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { SessionMessageEntry } from "../../src/agents/sessions/session-manager-types.js";
import { CURRENT_SESSION_VERSION } from "../../src/config/sessions/version.js";
import type { PersistedUserTurnMessage } from "../../src/sessions/user-turn-transcript.types.js";

const { values } = parseArgs({
  options: {
    "owner-file": { type: "string", default: "src/agents/sessions/session-manager-append.ts" },
    iterations: { type: "string", default: "5000" },
    allocation: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const {
  SessionManagerAppend,
}: typeof import("../../src/agents/sessions/session-manager-append.js") = await import(
  pathToFileURL(path.resolve(values["owner-file"])).href
);
class ReceiptManager extends SessionManagerAppend {
  acknowledge(entry: SessionMessageEntry) {
    return this.adoptPersistedEntry(
      { ...entry },
      { appended: false, adoptedMessageId: entry.id, effectiveParentId: entry.parentId },
      undefined,
      () => {},
    );
  }
}
const message = (index: number): SessionMessageEntry & { message: PersistedUserTurnMessage } => ({
  type: "message",
  id: `entry-${index}`,
  parentId: index ? `entry-${index - 1}` : null,
  timestamp: "2026-01-01T00:00:00.000Z",
  message: {
    role: "user",
    content: "Synthetic child result. ".repeat(32),
    timestamp: index,
    idempotencyKey: `input-${index}`,
  },
});
const entries = Array.from({ length: 160 }, (_, index) => message(index));
const managers = Array.from(
  { length: 64 },
  (_, index) =>
    new ReceiptManager("/synthetic", undefined, [
      {
        type: "session",
        version: CURRENT_SESSION_VERSION,
        id: `session-${index}`,
        cwd: "/synthetic",
      },
      ...entries,
    ]),
);
let accepted = 0;
let rejected = 0;
const run = (count: number) => {
  for (let index = 0; index < count; index++) {
    try {
      const receipt = managers[index % managers.length]!.acknowledge(entries[0]!);
      assert.equal(receipt.appended, false);
      accepted++;
    } catch (error) {
      assert(error instanceof Error && error.message.startsWith("Session transcript keyed user"));
      rejected++;
    }
  }
};
run(100);
accepted = rejected = 0;
global.gc?.();
const inspector = new Session();
if (values.allocation) {
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
}
const hostLoad = loadavg();
const cpuStart = process.threadCpuUsage();
const started = performance.now();
run(iterations);
const elapsedMs = performance.now() - started;
const cpu = process.threadCpuUsage(cpuStart);
let sampledBytes: number | undefined;
if (values.allocation) {
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  const sum = (node: HeapProfiler.SamplingHeapProfileNode): number =>
    node.selfSize + node.children.reduce((total, child) => total + sum(child), 0);
  sampledBytes = sum(profile.head);
  inspector.disconnect();
}
for (const manager of managers) {
  assert.equal(manager.getAppendParentId(), "entry-159");
}
console.log(
  JSON.stringify({
    iterations,
    accepted,
    rejected,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    sampledBytes,
    hostLoad,
    memory: process.memoryUsage(),
  }),
);
