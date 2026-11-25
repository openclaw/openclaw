/**
 * Owner-only probe: node --expose-gc --import ./scripts/tsx.mjs
 * scripts/perf/session-source-preparation.ts [--owner /absolute/path/to/owner.ts]
 * [--mode cpu|allocation] [--iterations 10000]
 * Run baseline/candidate alternately in fresh processes; allocation sampling is
 * separate from CPU timing and includes collected objects. No Gateway or real state.
 */
import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import os from "node:os";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type * as Owner from "../../src/config/sessions/session-source-authority.js";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    mode: { type: "string", default: "cpu" },
    iterations: { type: "string", default: "10000" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(values.mode === "cpu" || values.mode === "allocation");
assert(globalThis.gc, "Run with --expose-gc");
const owner: typeof Owner = await import(
  values.owner
    ? pathToFileURL(values.owner).href
    : "../../src/config/sessions/session-source-authority.js"
);
let assertions = 0;
let releases = 0;
function source(): Owner.SessionSourceAssertion {
  const assertCurrent = () => {
    assertions++;
  };
  const prepare = async (): Promise<Owner.PreparedSessionSourceAuthority> => ({
    assertCurrent,
    checks: [],
    release: () => {
      releases++;
    },
  });
  return Object.assign(assertCurrent, {
    prepareSessionSource: prepare,
    prepareSessionSourceScope: prepare,
  });
}

for (const [scenario, count, scoped] of [
  ["single", 1, false],
  ["composed", 4, false],
  ["scoped", 4, true],
] as const) {
  const assertion = owner.composeSessionSourceAssertion(Array.from({ length: count }, source));
  async function run(n: number) {
    for (let i = 0; i < n; i++) {
      const prepared = scoped
        ? await assertion.prepareSessionSourceScope!()
        : await assertion.prepareSessionSource();
      assert(prepared);
      prepared.assertCurrent();
      prepared.assertPreparedCurrent!();
      await prepared.release!();
    }
  }
  await run(2000);
  globalThis.gc();
  assertions = 0;
  releases = 0;
  const inspector = new Session();
  if (values.mode === "allocation") {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 1024,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const load = os.loadavg();
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  await run(iterations);
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(cpuStart);
  let sampledBytes: number | undefined;
  if (values.mode === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    inspector.disconnect();
  }
  assert.equal(assertions, iterations * count * 2);
  assert.equal(releases, iterations * count);
  console.log(
    JSON.stringify({
      scenario,
      mode: values.mode,
      iterations,
      load,
      cpuUsPerOperation: (cpu.user + cpu.system) / iterations,
      wallNsPerOperation: (wallMs * 1e6) / iterations,
      sampledBytesPerOperation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      assertions,
      releases,
    }),
  );
}
