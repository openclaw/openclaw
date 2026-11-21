/**
 * Missing models.json cost lookup: the owner of measured periodic main-thread lstat.
 * Run with Node 26, --expose-gc and the repository scripts/tsx.mjs loader.
 * --owner selects an intact checkout; --fixture-root must be a scratch directory.
 * Keep counts separate from timing. Run A1/B/A2 serially five times.
 * Acceptance: 66 periodic main-thread sync calls -> 0; retained prices unchanged.
 * This measures pricing-owner work, not Gateway latency or kernel syscall totals.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    owner: { type: "string", default: process.cwd() },
    "fixture-root": { type: "string" },
    mode: { type: "string", default: "timing" },
    iterations: { type: "string", default: "10000" },
  },
});
assert(values["fixture-root"], "Specify a scratch fixture root");
assert(["counts", "timing"].includes(values.mode));
assert(globalThis.gc, "Run with --expose-gc");
assert(
  Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Requires Node 26 allocation counter",
);
const iterations = values.mode === "counts" ? 66 : Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const owner = path.resolve(values.owner);
const sourceHashes = Object.fromEntries(
  [
    "src/utils/usage-format.ts",
    "src/agents/models-config-state.ts",
    "src/model-catalog/pricing.ts",
  ].map((file) => [
    file,
    createHash("sha256")
      .update(fs.readFileSync(path.join(owner, file)))
      .digest("hex"),
  ]),
);
const { resolveModelCostConfig } = await import(
  pathToFileURL(path.join(owner, "src/utils/usage-format.ts")).href
);
fs.mkdirSync(values["fixture-root"], { recursive: true });
const agentDir = fs.mkdtempSync(path.join(values["fixture-root"], "pricing-missing-"));
const params = {
  provider: "synthetic",
  model: "missing",
  agentDir,
  allowPluginNormalization: false,
};
const originals = new Map();
let counts = {};
if (values.mode === "counts") {
  for (const name of Object.keys(fs).filter(
    (key) => key.endsWith("Sync") && typeof fs[key] === "function",
  )) {
    const original = fs[name];
    originals.set(name, original);
    fs[name] = new Proxy(original, {
      apply(target, thisArg, args) {
        counts[name] = (counts[name] ?? 0) + 1;
        return Reflect.apply(target, thisArg, args);
      },
    });
  }
  const original = fsp.readFile;
  originals.set("asyncReadFile", original);
  fsp.readFile = new Proxy(original, {
    apply(target, thisArg, args) {
      counts.asyncReadFile = (counts.asyncReadFile ?? 0) + 1;
      return Reflect.apply(target, thisArg, args);
    },
  });
}
async function run(count) {
  let unexpectedPrices = 0;
  for (let index = 0; index < count; index++) {
    if ((await resolveModelCostConfig(params)) !== undefined) {
      unexpectedPrices++;
    }
  }
  assert.equal(unexpectedPrices, 0);
}
async function measure(phase, count) {
  globalThis.gc();
  counts = {};
  const hostLoad = loadavg();
  const allocation = getHeapStatistics().total_allocated_bytes;
  const cpu = process.threadCpuUsage();
  const processCpu = process.cpuUsage();
  const started = performance.now();
  await run(count);
  const wallMs = performance.now() - started;
  const cpuDelta = process.threadCpuUsage(cpu);
  const processCpuDelta = process.cpuUsage(processCpu);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
  return {
    phase,
    count,
    counts: { ...counts },
    wallMs,
    mainCpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
    processCpuMs: (processCpuDelta.user + processCpuDelta.system) / 1000,
    allocatedBytes,
    hostLoad,
  };
}
try {
  const cold = await measure("cold", 1);
  if (values.mode === "timing") {
    await run(1000);
  }
  const warm = await measure("warm", iterations);
  console.log(
    JSON.stringify({
      node: process.version,
      mode: values.mode,
      sourceHashes,
      results: [cold, warm],
    }),
  );
} finally {
  for (const [name, original] of originals) {
    if (name === "asyncReadFile") {
      fsp.readFile = original;
    } else {
      fs[name] = original;
    }
  }
  fs.rmSync(agentDir, { recursive: true, force: true });
}
