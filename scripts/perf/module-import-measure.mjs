/**
 * node scripts/perf/module-import-measure.mjs --entry /absolute/built/module.js
 *   --iterations 5 --output result.json [--mode timing|allocation] [--preload loader.mjs]
 * Use only trusted, side-effect-free import entries: this imports but calls no API.
 * Each iteration starts a fresh child with isolated HOME/config/state.
 * Allocation sampling distorts CPU: use timing-mode CPU/elapsed results. Script
 * census enables Debugger only after import, sampling, and forced-GC heap readings.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    entry: { type: "string" },
    iterations: { type: "string", default: "5" },
    output: { type: "string" },
    mode: { type: "string", default: "timing" },
    preload: { type: "string" },
    sample: { type: "boolean" },
  },
});
const iterations = Number(values.iterations);
if (
  !values.entry ||
  !path.isAbsolute(values.entry) ||
  !values.output ||
  !Number.isSafeInteger(iterations) ||
  iterations < 1 ||
  !["timing", "allocation"].includes(values.mode)
) {
  throw new Error(
    "Expected --entry <absolute built file> --output <json> [--iterations positive-integer] [--mode timing|allocation]",
  );
}
const output = path.resolve(values.output);
const write = (value) => writeFileSync(output, `${JSON.stringify(value, null, 2)}\n`);
mkdirSync(path.dirname(output), { recursive: true });
if (values.sample) {
  if (!global.gc) {
    throw new Error("Samples require --expose-gc");
  }
  const inspector = new Session();
  inspector.connect();
  const entryUrl = pathToFileURL(values.entry).href;
  performance.now();
  global.gc();
  const before = process.memoryUsage();
  const hostLoad = loadavg();
  if (values.mode === "allocation") {
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 16384,
      includeObjectsCollectedByMinorGC: true,
      includeObjectsCollectedByMajorGC: true,
    });
  }
  const started = performance.now();
  const cpuStart = process.threadCpuUsage();
  await import(entryUrl);
  const cpu = process.threadCpuUsage(cpuStart);
  const elapsedMs = performance.now() - started;
  const allocatedBytes =
    values.mode === "allocation"
      ? await inspector
          .post("HeapProfiler.stopSampling")
          .then(({ profile }) => profile.samples.reduce((sum, sample) => sum + sample.size, 0))
      : null;
  global.gc();
  const after = process.memoryUsage();
  let loadedScripts = 0;
  inspector.on("Debugger.scriptParsed", () => loadedScripts++);
  await inspector.post("Debugger.enable");
  inspector.disconnect();
  write({
    mode: values.mode,
    elapsedMs,
    cpuMs: (cpu.user + cpu.system) / 1000,
    allocatedBytes,
    loadedScripts,
    before,
    after,
    hostLoad,
    heapDeltaBytes: after.heapUsed - before.heapUsed,
    rssDeltaBytes: after.rss - before.rss,
  });
} else {
  const root = mkdtempSync(path.join(path.dirname(output), "module-import-"));
  const samples = [];
  try {
    for (let iteration = 1; iteration <= iterations; iteration++) {
      const state = path.join(root, String(iteration));
      mkdirSync(state);
      const sampleOutput = path.join(state, "sample.json");
      const args = [
        "--expose-gc",
        ...(values.preload ? ["--import", pathToFileURL(path.resolve(values.preload)).href] : []),
        fileURLToPath(import.meta.url),
        "--sample",
      ];
      for (const [key, value] of Object.entries({
        entry: values.entry,
        mode: values.mode,
        output: sampleOutput,
      })) {
        args.push(`--${key}`, value);
      }
      const run = spawnSync(process.execPath, args, {
        encoding: "utf8",
        timeout: 120_000,
        env: {
          ...process.env,
          HOME: state,
          USERPROFILE: state,
          OPENCLAW_HOME: state,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: path.join(state, "openclaw.json"),
          OPENCLAW_AGENT_DIR: path.join(state, "agent"),
          TMPDIR: state,
        },
      });
      if (run.status !== 0) {
        throw new Error(`Import sample failed: ${run.error ?? run.stderr}`);
      }
      samples.push(Object.assign({ iteration }, JSON.parse(readFileSync(sampleOutput, "utf8"))));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  const metrics = "elapsedMs cpuMs allocatedBytes loadedScripts heapDeltaBytes rssDeltaBytes".split(
    " ",
  );
  const medians = Object.fromEntries(
    metrics.map((metric) => {
      const points = samples
        .map((sample) => sample[metric])
        .filter((value) => value !== null)
        .toSorted((a, b) => a - b);
      const middle = Math.floor(points.length / 2);
      const value = points.length % 2 ? points[middle] : (points[middle - 1] + points[middle]) / 2;
      return [metric, points.length ? value : null];
    }),
  );
  write({
    entry: values.entry,
    preload: values.preload ? path.resolve(values.preload) : null,
    node: process.version,
    iterations,
    mode: values.mode,
    cpuBoundary: "main OS thread, import only; allocation-mode CPU is diagnostic",
    allocationBoundary:
      "V8 sampled JS bytes, including collected objects; excludes native/external allocations",
    medians,
    samples,
  });
  console.log(JSON.stringify({ output, medians }));
}
