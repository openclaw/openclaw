/** Run with node --expose-gc --import ./scripts/tsx.mjs. */
import { Session } from "node:inspector/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { resolveStateDir } from "../../src/config/state-dir.js";
import { resolveOpenClawAgentSqlitePath } from "../../src/state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../../src/state/openclaw-state-db.paths.js";

const { values } = parseArgs({
  options: {
    iterations: { type: "string", default: "100000" },
    rounds: { type: "string", default: "5" },
  },
});
const iterations = Number(values.iterations);
const rounds = Number(values.rounds);
if (
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !Number.isSafeInteger(rounds) ||
  rounds < 1
) {
  throw new Error("iterations and rounds must be positive integers");
}
if (!globalThis.gc) {
  throw new Error("Run with --expose-gc");
}
const roots = [
  { OPENCLAW_STATE_DIR: "/synthetic/openclaw/first" },
  { OPENCLAW_STATE_DIR: "/synthetic/openclaw/second" },
] as const;
const agentOptions = { agentId: "worker", env: roots[0] };
const explicit = { ...agentOptions, path: "/synthetic/custom.sqlite" };
const coldRoots = Array.from({ length: iterations }, (_, index) => ({
  OPENCLAW_STATE_DIR: `/synthetic/cold/${index}`,
}));
const workloads: Record<string, (index: number) => string> = {
  "state-dir": () => resolveStateDir(roots[0]),
  "state-db": () => resolveOpenClawStateSqlitePath(roots[0]),
  "agent-db": () => resolveOpenClawAgentSqlitePath(agentOptions),
  "interleaved-state-db": (index) => resolveOpenClawStateSqlitePath(roots[index % 2]),
  "explicit-agent-db": () => resolveOpenClawAgentSqlitePath(explicit),
  "cold-state-db": (index) => resolveOpenClawStateSqlitePath(coldRoots[index]!),
};
const inspector = new Session();
inspector.connect();
let checksum = 0;
try {
  for (const [workload, resolve] of Object.entries(workloads)) {
    for (let index = 0; index < 1000; index++) {
      checksum += resolve(index % iterations).length;
    }
    // Count exported path operations separately: instrumentation is not timed.
    const counts = { resolve: 0, join: 0 };
    const originalResolve = path.resolve;
    const originalJoin = path.join;
    path.resolve = (...parts) => {
      counts.resolve++;
      return originalResolve(...parts);
    };
    path.join = (...parts) => {
      counts.join++;
      return originalJoin(...parts);
    };
    try {
      for (let index = 0; index < iterations; index++) {
        checksum += resolve(index).length;
      }
    } finally {
      path.resolve = originalResolve;
      path.join = originalJoin;
    }
    console.log(JSON.stringify({ workload, iterations, counts }));
    for (let round = 0; round < rounds; round++) {
      globalThis.gc();
      const start = process.hrtime.bigint();
      for (let index = 0; index < iterations; index++) {
        checksum += resolve(index).length;
      }
      const nsPerOperation = Number(process.hrtime.bigint() - start) / iterations;
      globalThis.gc();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 4096,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
      for (let index = 0; index < iterations; index++) {
        checksum += resolve(index).length;
      }
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
          nsPerOperation,
          bytesPerOperation: allocatedBytes / iterations,
        }),
      );
    }
  }
} finally {
  inspector.disconnect();
}
console.log(JSON.stringify({ checksum }));
