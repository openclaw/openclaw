// Bundle each revision's src/gateway/operator-role-source-policy.ts with esbuild
// --bundle --platform=node --format=esm --outfile=<revision>.mjs, then run:
// node --expose-gc scripts/perf/operator-role-source-policy-measure.mjs \
//   --base <base.mjs> --candidate <candidate.mjs> --iterations 100000 --pairs 5
// Serial AB/BA owner checks, separate timing/allocation passes, synthetic roles.
// Acceptance: repeatable allocation/CPU reduction without material CPU regression.
// This does not measure whole-Gateway latency or authorize a production load test.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    iterations: { type: "string", default: "100000" },
    pairs: { type: "string", default: "5" },
  },
});
assert(values.base && values.candidate && globalThis.gc);
const iterations = Number(values.iterations);
const pairs = Number(values.pairs);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(Number.isSafeInteger(pairs) && pairs > 0);
const modules = {
  base: await import(pathToFileURL(values.base).href),
  candidate: await import(pathToFileURL(values.candidate).href),
};
const roles = Array.from({ length: 40 }, (_, index) => ({
  sessions: { others: "view" },
  agents: ["main", "assistant", "reviewer", "worker"],
  scopes: [
    "operator.read",
    "operator.talk",
    "operator.talk.secrets",
    "operator.pairing",
    "operator.approvals",
    "operator.questions",
  ],
  sandbox: "required",
  accessPolicyPlugin: `synthetic-policy-${index}`,
}));
const requests = {
  "first-grant": ["operator.read"],
  "multiple-grants": ["operator.read", "operator.talk", "operator.approvals"],
};
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const [scenario, scopes] of Object.entries(requests)) {
    for (const mode of ["timing", "allocation"]) {
      for (let pair = 0; pair < pairs; pair++) {
        for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
          const { sourceRolePolicy, isOperatorRoleSourcePolicyCurrent } = modules[arm];
          const captured = roles.map((role) => sourceRolePolicy(structuredClone(role)));
          const check = (index) => {
            const slot = index % roles.length;
            return isOperatorRoleSourcePolicyCurrent(
              captured[slot],
              sourceRolePolicy(roles[slot]),
              scopes,
            );
          };
          for (let index = 0; index < 10000; index++) {
            assert(check(index));
          }
          globalThis.gc();
          if (mode === "allocation") {
            await inspector.post("HeapProfiler.startSampling", {
              samplingInterval: 8192,
              includeObjectsCollectedByMajorGC: true,
              includeObjectsCollectedByMinorGC: true,
            });
          }
          const hostLoad = loadavg();
          const cpu = process.threadCpuUsage();
          const start = performance.now();
          let allowed = 0;
          for (let index = 0; index < iterations; index++) {
            allowed += Number(check(index));
          }
          const elapsedMs = performance.now() - start;
          const used = process.threadCpuUsage(cpu);
          assert.equal(allowed, iterations);
          let allocatedBytes;
          if (mode === "allocation") {
            const { profile } = await inspector.post("HeapProfiler.stopSampling");
            const total = (node) =>
              node.selfSize + node.children.reduce((sum, child) => sum + total(child), 0);
            allocatedBytes = total(profile.head);
          }
          const revoked = { ...roles[0], scopes: [] };
          assert.equal(
            isOperatorRoleSourcePolicyCurrent(captured[0], sourceRolePolicy(revoked), scopes),
            false,
          );
          results.push({
            scenario,
            mode,
            pair: pair + 1,
            arm,
            iterations,
            hostLoad,
            elapsedMs,
            checksPerSecond: (iterations * 1000) / elapsedMs,
            cpuNsPerCheck: ((used.user + used.system) * 1000) / iterations,
            allocatedBytesPerCheck:
              allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
          });
        }
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, warmup: 10000, results }, null, 2));
} finally {
  inspector.disconnect();
}
