/**
 * Warm visitor welcome lookup, using the configured maximum of 500 synthetic grants.
 * Run on each revision: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/visitor-welcome-lookup-measure.ts
 * Five timing/CPU passes and a separate allocation pass, 3,000 lookups each.
 * No Gateway/Cloudflare calls: this isolates invitation lookup before sessions.describe.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import type { PluginStateKeyedStore } from "../../extensions/visitor-access/api.js";
import { VisitorPolicyClient } from "../../extensions/visitor-access/src/cloudflare.js";
import type { VisitorGrant } from "../../extensions/visitor-access/src/grant-record.js";
import { VisitorAccessService } from "../../extensions/visitor-access/src/visitors.js";

const iterations = 3000;
const grants: VisitorGrant[] = Array.from({ length: 500 }, (_, index) => ({
  email: `visitor-${index}@example.invalid`,
  grantId: randomUUID(),
  createdAt: 1,
  expiresAt: null,
  onboarding: {
    state: "ready",
    welcomeSessionKey: `agent:main:dashboard:welcome-${index}`,
    updatedAt: 2,
  },
}));
const config = {
  accountId: "synthetic",
  appId: "synthetic",
  apiToken: "synthetic-not-a-credential",
  policyName: "synthetic",
  defaultTtlDays: 14,
  maxVisitors: 500,
};
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected external operation");
};
const store = {
  entries: async () =>
    grants.map((value, index) => ({
      key: `visitor-${index}@example.invalid`,
      value,
      createdAt: 1,
    })),
} as PluginStateKeyedStore<VisitorGrant>;
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const service = new VisitorAccessService(
  config,
  store,
  new VisitorPolicyClient(config, unexpected),
  logger,
  unexpected,
  unexpected,
);
await service.initialize();
const selected = grants.at(-1)!;
assert(selected.grantId);
const grantId = selected.grantId;
const lookup = () => service.findActiveInvitation(grantId);
try {
  assert.deepEqual(lookup(), selected);
  for (let i = 0; i < 1000; i++) {
    lookup();
  }
  const timings = [];
  for (let pass = 0; pass < 5; pass++) {
    globalThis.gc?.();
    const latencies = new Float64Array(iterations);
    const hostLoad = loadavg();
    const cpuStart = process.cpuUsage();
    for (let i = 0; i < iterations; i++) {
      const start = performance.now();
      lookup();
      latencies[i] = performance.now() - start;
    }
    const cpu = process.cpuUsage(cpuStart);
    latencies.sort();
    timings.push({
      cpuUsPerCall: (cpu.user + cpu.system) / iterations,
      p50Ms: latencies[Math.floor(iterations * 0.5)],
      p99Ms: latencies[Math.floor(iterations * 0.99)],
      hostLoad,
    });
  }
  const inspector = new Session();
  inspector.connect();
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 128,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  for (let i = 0; i < iterations; i++) {
    lookup();
  }
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  inspector.disconnect();
  const bytes = profile.samples.reduce((total, sample) => total + sample.size, 0);
  assert.deepEqual(lookup(), selected);
  console.log(
    JSON.stringify({
      iterations,
      grants: grants.length,
      timings,
      sampledBytesPerCall: bytes / iterations,
    }),
  );
} finally {
  service.close();
}
