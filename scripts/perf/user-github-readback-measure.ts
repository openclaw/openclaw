/**
 * Personal GitHub worker-reply CPU/allocation benchmark with 40 synthetic owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/user-github-readback-measure.ts
 * Five alternating AB/BA passes of 3,000 records per arm, then separate allocation
 * passes. Baseline executes the retained parser used before this change; candidate
 * registers secrets on the already-validated reply. Fixtures/imports are untimed.
 * Acceptance: identical records and lower CPU/allocation without weakening storage
 * validation. This isolates reply handling; it makes no whole-Gateway latency claim.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import {
  parseUserGitHubConnection,
  registerUserGitHubConnectionSecrets,
} from "../../src/state/user-github-connections.kernel.js";
import type { UserGitHubConnection } from "../../src/state/user-github-connections.types.js";

const iterations = 3_000;
const fixtures = Array.from({ length: 40 }, (_, index): UserGitHubConnection => {
  const record: UserGitHubConnection = {
    version: 1,
    generation: "00000000-0000-4000-8000-000000000001",
    selection: { kind: "disconnected" },
  };
  const profileId = `ghp_${index.toString(16).padStart(32, "0")}`;
  const tokens = {
    accessToken: `synthetic-access-${index}`,
    refreshToken: `synthetic-refresh-${index}`,
    tokenType: "bearer" as const,
    scopes: ["repo", "workflow"],
    expiresInSeconds: 3_600,
    refreshTokenExpiresInSeconds: 86_400,
  };
  if (index % 4 === 1) {
    record.pending = {
      kind: "starting",
      requestId: record.generation,
      createdAtMs: 1_000_000,
      expiresAtMs: 1_900_000,
    };
  } else if (index % 4 === 2) {
    record.pending = {
      kind: "device",
      requestId: record.generation,
      createdAtMs: 1_000_000,
      expiresAtMs: 1_900_000,
      deviceCode: `synthetic-device-${index}`.padEnd(40, "x"),
      userCode: "TEST-0000",
      verificationUri: "https://github.com/login/device",
      pollIntervalMs: 5_000,
      nextPollAtMs: 1_005_000,
      candidate: { profileId, tokens, receivedAtMs: 1_010_000 },
    };
  } else if (index % 4 === 3) {
    record.selection = {
      kind: "connected",
      profileId,
      accountId: index + 1,
      login: `synthetic-user-${index}`,
      refreshToken: tokens.refreshToken,
      scopes: tokens.scopes,
      accessExpiresAtMs: 4_600_000,
      refreshExpiresAtMs: 87_400_000,
      refresh: { operationId: record.generation, tokens, receivedAtMs: 1_000_000 },
    };
  }
  return parseUserGitHubConnection(JSON.stringify(record));
});
const operations = {
  base: (record: UserGitHubConnection) => parseUserGitHubConnection(JSON.stringify(record)),
  candidate: registerUserGitHubConnectionSecrets,
};
type Arm = keyof typeof operations;
const order = (pass: number): Arm[] =>
  pass % 2 === 0 ? ["base", "candidate"] : ["candidate", "base"];
const run = (arm: Arm, count: number) => {
  for (let index = 0; index < count; index++) {
    operations[arm](fixtures[index % fixtures.length]!);
  }
};
for (const record of fixtures) {
  assert.deepEqual(operations.candidate(record), operations.base(record));
}
run("base", 500);
run("candidate", 500);
const timings = [];
for (let pass = 0; pass < 5; pass++) {
  for (const arm of order(pass)) {
    globalThis.gc?.();
    const load = loadavg();
    const cpu = process.threadCpuUsage();
    const start = performance.now();
    run(arm, iterations);
    const elapsedMs = performance.now() - start;
    const used = process.threadCpuUsage(cpu);
    timings.push({ pass, arm, elapsedMs, cpuMs: (used.user + used.system) / 1_000, load });
  }
}
const inspector = new Session();
const allocations = [];
inspector.connect();
try {
  for (let pass = 0; pass < 5; pass++) {
    for (const arm of order(pass)) {
      globalThis.gc?.();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4_096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      run(arm, iterations);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocations.push({
        pass,
        arm,
        sampledBytes: profile.samples.reduce((sum, sample) => sum + sample.size, 0),
      });
    }
  }
  console.log(
    JSON.stringify({
      node: process.version,
      owners: fixtures.length,
      iterations,
      timings,
      allocations,
    }),
  );
} finally {
  inspector.disconnect();
}
