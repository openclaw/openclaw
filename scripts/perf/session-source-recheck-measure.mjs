// Bundle each revision's src/config/sessions/session-source-authority.ts with:
// node_modules/.bin/esbuild <source> --bundle --platform=node --format=esm --outfile=<arm>.mjs
// node --expose-gc scripts/perf/session-source-recheck-measure.mjs \
//   --base <base.mjs> --candidate <candidate.mjs> --iterations 5000 --pairs 5
// Acceptance: fewer issued-source checks and sampled bytes with no repeatable CPU
// regression. Serial AB/BA; separate timing/allocation passes (1024-byte sampling).
// 64 caller graphs, 8 forwarding layers and 8 synchronous effects per synthetic
// turn. Repeat with --opaque to keep every callback live as an opaque boundary.
// This isolates composition, not model turns, SQLite IO or Gateway latency.
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    candidate: { type: "string" },
    iterations: { type: "string", default: "5000" },
    pairs: { type: "string", default: "5" },
    opaque: { type: "boolean", default: false },
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
const inspector = new Session();
inspector.connect();
const results = [];
try {
  for (const mode of ["timing", "allocation"]) {
    for (let pair = 0; pair < pairs; pair++) {
      for (const arm of pair % 2 ? ["candidate", "base"] : ["base", "candidate"]) {
        const owner = modules[arm];
        let checks = 0;
        let revoked = false;
        const callers = Array.from({ length: 64 }, () => {
          const source = () => {
            checks++;
            assert(!revoked, "source revoked");
          };
          if (!values.opaque) {
            owner.bindSynchronousSessionSource(source);
          }
          let graph = source;
          for (let depth = 0; depth < 8; depth++) {
            graph = owner.composeSessionSourceAssertion([graph, source]);
          }
          return graph;
        });
        const turn = (index) => {
          const check = callers[index % callers.length];
          for (let effect = 0; effect < 8; effect++) {
            owner.withSessionSourceValidation(check);
          }
        };
        for (let index = 0; index < 2000; index++) {
          turn(index);
        }
        globalThis.gc();
        if (mode === "allocation") {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 1024,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        checks = 0;
        const hostLoad = loadavg();
        const cpu = process.threadCpuUsage();
        const started = performance.now();
        for (let index = 0; index < iterations; index++) {
          turn(index);
        }
        const wallMs = performance.now() - started;
        const used = process.threadCpuUsage(cpu);
        let allocatedBytes;
        if (mode === "allocation") {
          const { profile } = await inspector.post("HeapProfiler.stopSampling");
          allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
        }
        results.push({
          arm,
          mode,
          pair: pair + 1,
          iterations,
          hostLoad,
          wallMs,
          checksPerTurn: checks / iterations,
          cpuNsPerTurn: ((used.user + used.system) * 1000) / iterations,
          allocatedBytesPerTurn:
            allocatedBytes === undefined ? undefined : allocatedBytes / iterations,
        });
        revoked = true;
        assert.throws(() => turn(0), /source revoked/);
      }
    }
  }
  console.log(
    JSON.stringify(
      {
        node: process.version,
        opaque: values.opaque,
        callers: 64,
        depth: 8,
        effectsPerTurn: 8,
        results,
      },
      null,
      2,
    ),
  );
} finally {
  inspector.disconnect();
}
