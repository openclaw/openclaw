/**
 * Owner benchmark, not a whole-Gateway load test. Run on each revision:
 * node --import ./scripts/tsx.mjs scripts/perf/ingress-blocked-lanes.ts
 * Use --allocation for a separate sampled-allocation pass; --iterations defaults to 3000.
 * Counterbalance base/candidate launches. CPU runs have no inspector attached.
 * Synthetic queue snapshots model 64 active, 64 foreign-claimed and 64 delayed lanes.
 * Database reads are fixed fixtures so the measured work belongs to the drain owner.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { parseArgs } from "node:util";
import { createChannelIngressDrainOwner } from "../../src/channels/message/ingress-drain.js";
import type {
  ChannelIngressQueue,
  ChannelIngressQueueClaim,
  ChannelIngressQueueRecord,
} from "../../src/channels/message/ingress-queue.types.js";

const { values } = parseArgs({
  options: {
    allocation: { type: "boolean", default: false },
    iterations: { type: "string", default: "3000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const now = 10_000;
const lanes = 64;
const scope = { channelId: "synthetic", accountId: "bench", queueName: "bench" };
const record = (id: string, laneKey: string): ChannelIngressQueueRecord<string> => ({
  ...scope,
  id,
  laneKey,
  payload: id,
  receivedAt: 1,
  updatedAt: now,
  attempts: 0,
});
const claimed = (kind: string, index: number): ChannelIngressQueueClaim<string> => ({
  ...record(`${kind}-${index}`, `${kind}-${(index * 17) % lanes}`),
  claim: { token: `${kind}-${index}`, ownerId: kind, claimedAt: now },
});
const active = Array.from({ length: lanes }, (_, i) => claimed("active", i));
const claims = [...active, ...Array.from({ length: lanes }, (_, i) => claimed("foreign", i))];
const pending = [
  ...claims.map((row) => record(`tail-${row.id}`, row.laneKey!)),
  ...Array.from({ length: lanes }, (_, i) => ({
    ...record(`retry-${i}`, `retry-${(i * 17) % lanes}`),
    attempts: 1,
    lastAttemptAt: now,
    lastError: "synthetic retry",
  })),
];
const unexpected = async (): Promise<never> => {
  throw new Error("Blocked fixture must not write to the queue");
};
const queue: ChannelIngressQueue<string> = {
  listUnsettled: async () => ({ pending, claims }),
  listPending: async () => pending,
  listClaims: async () => claims,
  enqueue: unexpected,
  claim: unexpected,
  claimNext: unexpected,
  complete: unexpected,
  release: unexpected,
  fail: unexpected,
  delete: unexpected,
  prune: unexpected,
  recoverStaleClaims: unexpected,
};
const drain = createChannelIngressDrainOwner({
  queue,
  now: () => now,
  dispatchClaimedEvent: () => ({ kind: "deferred" }),
});
const inspector = new Session();
try {
  for (const claim of active) {
    drain.dispatchClaimed(claim, Promise.resolve());
  }
  await drain.waitForIdle();
  const run = async (count: number) => {
    for (let i = 0; i < count; i++) {
      assert.equal((await drain.drainOnce({ recoverStaleClaims: false })).started, 0);
    }
  };
  await run(500);
  const hostLoad = loadavg();
  if (values.allocation) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  await run(iterations);
  const elapsedMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  let sampledBytes: number | undefined;
  if (values.allocation) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
  }
  console.log(
    JSON.stringify({
      iterations,
      lanesPerKind: lanes,
      allocation: values.allocation,
      hostLoad,
      elapsedMs,
      threadCpuMs: (cpu.user + cpu.system) / 1000,
      sampledBytes,
      sampledBytesPerDrain: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    }),
  );
} finally {
  inspector.disconnect();
  drain.dispose();
}
