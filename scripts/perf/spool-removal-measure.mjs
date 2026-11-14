// node --import ./scripts/tsx.mjs scripts/perf/spool-removal-measure.mjs
// --baseline <saved-spool-owner.ts> --output <new-directory> [--mode timing|resources|counts]
// Cold worker startup, five A/A controls, then five alternating A/B pairs; retained compiled worker.
// Timing and resource/counter passes stay separate. No Gateway/minute inference.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { drainGlobalSingletonLifecycleState } from "../../src/shared/global-singleton.ts";
import { observeMainThreadFs } from "../../src/test-utils/main-thread-fs-spies.test-support.ts";
import { createVitestWorkerRun } from "../lib/vitest-worker-run.mts";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    output: { type: "string" },
    mode: { type: "string", default: "timing" },
    samples: { type: "string", default: "5" },
    operations: { type: "string", default: "3" },
  },
});
assert(values.baseline && values.output, "--baseline and fresh --output directory are required");
assert(["timing", "resources", "counts"].includes(values.mode));
const samples = Number(values.samples),
  operations = Number(values.operations);
assert(Number.isSafeInteger(samples) && samples >= 5);
assert(Number.isSafeInteger(operations) && operations > 0 && operations <= 100);
assert(
  typeof process.threadCpuUsage === "function" &&
    Number.isFinite(getHeapStatistics().total_allocated_bytes),
  "Node26 counters required",
);
const output = path.resolve(values.output);
await fs.mkdir(output, { recursive: false });
const baselineSource = await fs.readFile(values.baseline, "utf8");
const ownerUrl = new URL("../../src/infra/outbound/delivery-queue-media-spool.ts", import.meta.url);
const candidateSource = await fs.readFile(ownerUrl, "utf8");
const baselineUrl = `${ownerUrl.href}?spoolMeasure=baseline`;
const loader = registerHooks({
  load(url, context, nextLoad) {
    return url === baselineUrl
      ? { format: "module", source: stripTypeScriptTypes(baselineSource), shortCircuit: true }
      : nextLoad(url, context);
  },
});
const compiled = createVitestWorkerRun();
const workers = new Set();
const onWorker = (worker) => {
  workers.add(worker);
};
const sampleWorkers = () =>
  Promise.all(
    [...workers].map(async (worker) => {
      worker.ref();
      try {
        return {
          worker,
          cpu: await worker.cpuUsage(),
          allocated: (await worker.getHeapStatistics()).total_allocated_bytes,
        };
      } finally {
        worker.unref();
      }
    }),
  );
let sequence = 0;
const records = [];
try {
  const compiledManifest = await compiled.prepare();
  await fs.writeFile(
    path.join(output, "compiled-generation.json"),
    JSON.stringify(compiledManifest),
  );
  const { runtimeProcessEntrypoints } =
    await import("../../src/infra/runtime-process-entrypoints.ts");
  // Select the existing explicit-root resolver contract; hold its generation through all effects.
  Object.assign(runtimeProcessEntrypoints.fsSafeCopy, { root: compiled.descriptor.directory });
  const baseline = (await import(baselineUrl)).releaseSpoolArtifacts;
  const candidate = (await import(ownerUrl.href)).releaseSpoolArtifacts;
  if (values.mode === "resources") {
    process.on("worker", onWorker);
  }
  const cpuMs = ({ user, system }) => (user + system) / 1000;
  const run = async (owner, phase, pair, measured = true) => {
    const directory = path.join(output, `sample-${sequence++}`);
    const root = path.join(directory, "delivery-queue-media");
    await fs.mkdir(root, { recursive: true });
    const artifacts = Array.from({ length: operations }, (_, index) =>
      path.join(root, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}.ogg`),
    );
    for (const artifact of artifacts) {
      await fs.writeFile(artifact, Buffer.alloc(1024));
    }
    const beforeWorkers = values.mode === "resources" && measured ? await sampleWorkers() : [];
    const observer = values.mode === "counts" && measured ? observeMainThreadFs() : undefined;
    const before = {
      wall: performance.now(),
      process: process.cpuUsage(),
      thread: process.threadCpuUsage(),
      allocated: getHeapStatistics().total_allocated_bytes,
    };
    try {
      await (owner === "A" ? baseline : candidate)(artifacts, directory);
    } finally {
      observer?.[Symbol.dispose]();
    }
    const result = {
      phase,
      pair,
      owner,
      operations,
      mode: values.mode,
      load: loadavg(),
      sample: sequence - 1,
      wallMs: performance.now() - before.wall,
      processCpuMs: cpuMs(process.cpuUsage(before.process)),
      mainThreadCpuMs: cpuMs(process.threadCpuUsage(before.thread)),
      mainAllocatedBytes: getHeapStatistics().total_allocated_bytes - before.allocated,
      calls: observer?.calls(),
      stacks: observer?.stacks(),
    };
    assert.equal((await fs.readdir(root)).length, 0, "Actual artifact removal must complete");
    if (values.mode === "resources" && measured) {
      result.workers = (await sampleWorkers()).map((current, index) => {
        const previousWorker = beforeWorkers.find((entry) => entry.worker === current.worker);
        return {
          index,
          startup: previousWorker === undefined,
          cpuMs: cpuMs(current.cpu) - (previousWorker ? cpuMs(previousWorker.cpu) : 0),
          allocatedBytes: current.allocated - (previousWorker?.allocated ?? 0),
        };
      });
      assert(result.workers.length > 0, "The actual filesystem owner must be observed");
    }
    if (measured) {
      records.push(result);
      await fs.appendFile(path.join(output, "samples.jsonl"), JSON.stringify(result) + "\n");
    }
  };
  await run("A", "warmup", 0, false);
  await run("B", "cold", 0);
  for (let pair = 0; pair < samples; pair++) {
    await run("A", "AA", pair);
    await run("A", "AA", pair);
  }
  for (let pair = 0; pair < samples; pair++) {
    for (const owner of pair % 2 ? ["B", "A"] : ["A", "B"]) {
      await run(owner, "AB", pair);
    }
  }
  await fs.writeFile(
    path.join(output, "summary.json"),
    JSON.stringify(
      {
        compiledGeneration: compiledManifest.identity,
        runtime: process.version,
        platform: process.platform,
        arch: process.arch,
        baselineSha256: createHash("sha256").update(baselineSource).digest("hex"),
        candidateSha256: createHash("sha256").update(candidateSource).digest("hex"),
        mode: values.mode,
        samples,
        operations,
        records,
        scope:
          "Finite releaseSpoolArtifacts operations, APFS/local filesystem; no Gateway throughput inference",
        resourceScope:
          "Process CPU includes filesystem worker threads; worker CPU is a partition and is not added. Main+worker isolate allocation counters are separate; resource probe timing is diagnostic only. First candidate row includes cold worker startup; subsequent A/A and A/B rows reuse the same owner.",
      },
      null,
      2,
    ),
  );
} finally {
  loader.deregister();
  process.off("worker", onWorker);
  try {
    await drainGlobalSingletonLifecycleState("close");
    assert(
      [...workers].every((worker) => worker.threadId === -1),
      "All measured workers must join before releasing compiled artifacts",
    );
  } finally {
    await compiled.dispose();
  }
}
