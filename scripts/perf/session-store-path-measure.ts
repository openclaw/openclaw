/**
 * Warm session-store path work for 10.8k session identities across 40 agents.
 * Run on each revision in alternating order:
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/session-store-path-measure.ts
 *   --iterations 10800 --rounds 5
 * Each iteration makes three calls to model repeated watcher admission checks.
 * CPU is untraced; allocation uses a separate sampling pass.
 * MiB/min is normalized to 10,800 iterations/min, not a measured Gateway rate.
 * Acceptance: identical paths/checks and lower allocation and CPU across pairs.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveSessionStorePathCore } from "../../src/config/sessions/paths.js";
import { publishSystemEventStoreConfig } from "../../src/config/sessions/session-store-path.js";
import {
  captureSystemEventStoreCurrentCheck,
  getSystemEventStorePath,
  publishSystemEventStoreResolver,
} from "../../src/infra/system-event-ownership.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "10800" },
    rounds: { type: "string", default: "5" },
  },
});
const iterations = Number(values.iterations);
const rounds = Number(values.rounds);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(rounds) && rounds > 0);
assert(globalThis.gc, "Run with --expose-gc");
const previousStateDir = process.env.OPENCLAW_STATE_DIR;
process.env.OPENCLAW_STATE_DIR = path.resolve(".local/session-store-path-measure");
const inspector = new Session();
inspector.connect();
let checksum = 0;
try {
  publishSystemEventStoreConfig({});
  const fixtures = Array.from({ length: 10800 }, (_, index) => {
    const agentId = `worker-${index % 40}`;
    const sessionKey = `agent:${agentId}:subagent:synthetic-${index}`;
    const storePath = getSystemEventStorePath(sessionKey);
    assert(storePath);
    const current = captureSystemEventStoreCurrentCheck(sessionKey);
    assert(current(storePath));
    return { agentId, storePath, current };
  });
  for (const workload of ["default-store", "current-check"] as const) {
    const run = (count: number) => {
      for (let index = 0; index < count; index++) {
        const fixture = fixtures[index % fixtures.length]!;
        for (let check = 0; check < 3; check++) {
          checksum +=
            workload === "default-store"
              ? resolveSessionStorePathCore(undefined, fixture).length
              : Number(fixture.current(fixture.storePath));
        }
      }
    };
    run(10800);
    for (let round = 0; round < rounds; round++) {
      globalThis.gc();
      const load = os.loadavg();
      const cpu = process.cpuUsage();
      const start = performance.now();
      run(iterations);
      const wallMs = performance.now() - start;
      const used = process.cpuUsage(cpu);
      globalThis.gc();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      run(iterations);
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      let allocatedBytes = 0;
      const pending = [profile.head];
      while (pending.length) {
        const node = pending.pop()!;
        allocatedBytes += node.selfSize;
        pending.push(...node.children);
      }
      console.log(
        JSON.stringify({
          workload,
          round,
          iterations,
          load,
          wallMs,
          cpuMs: (used.user + used.system) / 1000,
          allocatedBytes,
          normalizedMiBPerMin: ((allocatedBytes / iterations) * 10800) / 1024 ** 2,
        }),
      );
    }
  }
  console.log(JSON.stringify({ checksum }));
} finally {
  inspector.disconnect();
  publishSystemEventStoreResolver(undefined);
  if (previousStateDir === undefined) {
    delete process.env.OPENCLAW_STATE_DIR;
  } else {
    process.env.OPENCLAW_STATE_DIR = previousStateDir;
  }
}
