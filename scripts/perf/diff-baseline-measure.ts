// Measure the uncached diff owner against a synthetic history-diff fixture:
// node --expose-gc --import ./scripts/tsx.mjs scripts/perf/diff-baseline-measure.ts \
//   --state-dir <team-shape-dir> --iterations 2000
// Seed with team-shape-fixture.ts, then history-diff-measure.ts --seed first.
// Run on each revision. --allocations selects a separate sampled allocation pass;
// its timings are diagnostic only. Real RPC proof uses history-diff-measure.ts
// --scenario diff-uncommitted-full --dirty-baseline (at seed time) --mutate.
// --source <saved-session-diff.runtime.ts> substitutes only that owner for
// alternating baseline/candidate samples; its relative imports remain unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import { Session, type HeapProfiler } from "node:inspector/promises";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean" },
    source: { type: "string" },
  },
});
assert(values["state-dir"], "--state-dir must name a synthetic history-diff fixture");
assert(global.gc, "Run with --expose-gc");
const root = path.resolve(values["state-dir"]);
const fixture: unknown = JSON.parse(
  await fs.readFile(path.join(root, "history-diff-fixture/summary.json"), "utf8"),
);
assert(isRecord(fixture));
assert.equal(fixture.format, "openclaw-history-diff-v1");
assert(typeof fixture.trackedFiles === "number" && typeof fixture.untrackedFiles === "number");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 2000,
});
Object.assign(process.env, {
  OPENCLAW_STATE_DIR: root,
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  TMPDIR: path.join(root, "tmp"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: os.devNull,
});
const owner = new URL("../../src/sessions/session-diff.runtime.ts", import.meta.url);
const source = readFileSync(values.source ? path.resolve(values.source) : owner, "utf8");
const sourceSha256 = createHash("sha256").update(source).digest("hex");
registerHooks({
  load(url, context, nextLoad) {
    return url === owner.href
      ? { format: "module-typescript", source, shortCircuit: true }
      : nextLoad(url, context);
  },
});
const { collectCheckoutDiff, collectCheckoutDiffBaseline } =
  await import("../../src/sessions/session-diff.runtime.js");
const { drainGlobalSingletonLifecycleState } = await import("../../src/shared/global-singleton.js");
const cwd = path.join(root, "history-diff-fixture/worktree");
const captured = await collectCheckoutDiffBaseline({ cwd });
assert(captured && !captured.truncated);
assert.equal(captured.files.length, fixture.trackedFiles + fixture.untrackedFiles);
const input = {
  cwd,
  scope: "uncommitted" as const,
  sessionId: "synthetic-baseline-measure",
  baseline: { ...captured, sessionId: "synthetic-baseline-measure" },
};
const read = async () => {
  const result = await collectCheckoutDiff(input);
  assert.equal(result.files.length, 0, "Unchanged pre-session files must remain hidden");
  assert.equal(result.additions, 0);
  assert.equal(result.deletions, 0);
};
function allocated(node: HeapProfiler.SamplingHeapProfileNode): number {
  return node.selfSize + node.children.reduce((sum, child) => sum + allocated(child), 0);
}
const inspector = new Session();
try {
  for (let index = 0; index < 5; index++) {
    await read();
  }
  global.gc();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const cpuBefore = process.cpuUsage();
  const samples: number[] = [];
  const hostLoad = os.loadavg();
  for (let index = 0; index < iterations; index++) {
    const started = performance.now();
    await read();
    samples.push(performance.now() - started);
  }
  const cpu = process.cpuUsage(cpuBefore);
  const profile = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile
    : undefined;
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      iterations,
      sourceSha256,
      hostLoad,
      elapsedMs: samples.reduce((sum, value) => sum + value, 0),
      p50Ms: samples[Math.ceil(iterations * 0.5) - 1],
      p99Ms: samples[Math.ceil(iterations * 0.99) - 1],
      processCpuMsPerDiff: (cpu.user + cpu.system) / 1000 / iterations,
      allocatedBytesPerDiff: profile ? allocated(profile.head) / iterations : undefined,
      memory: process.memoryUsage(),
    }),
  );
} finally {
  inspector.disconnect();
  await drainGlobalSingletonLifecycleState();
}
