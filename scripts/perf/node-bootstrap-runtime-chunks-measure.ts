/**
 * Bootstrap chunk selection over 40 synthetic plugins (30 omitted), four chunks each.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/node-bootstrap-runtime-chunks-measure.ts \
 *   --output "$PWD/.local/bootstrap-chunks-base" --module /absolute/base/node-bootstrap-runtime-chunks.ts
 * Repeat on the candidate, then repeat both with --allocations (ignore traced timings).
 * Default 20 preparations process 3,220 input files. --iterations changes this count.
 * Acceptance: identical selected bytes/import facts, less allocation/CPU; this is owner proof,
 * not a whole-Gateway claim. Output owns synthetic fixtures and removes them after the run.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    module: { type: "string" },
    output: { type: "string" },
    iterations: { type: "string", default: "20" },
    allocations: { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new directory for this run");
assert(global.gc, "Run with --expose-gc");
const iterations = parseStrictIntegerOption({
  raw: values.iterations,
  label: "--iterations",
  min: 1,
  fallback: 20,
});
const {
  resolveNodeBootstrapRuntimeChunks: resolveChunks,
}: typeof import("../../src/gateway/worker-environments/node-bootstrap-runtime-chunks.js") =
  await import(
    values.module
      ? pathToFileURL(path.resolve(values.module)).href
      : "../../src/gateway/worker-environments/node-bootstrap-runtime-chunks.js"
  );
const output = path.resolve(values.output);
await fs.mkdir(output);
const packageRoot = path.join(output, "fixture");
const inspector = new Session();
const pauses: number[] = [];
const observer = new PerformanceObserver((list) => {
  pauses.push(...list.getEntries().map((entry) => entry.duration));
});
const digest = (text: string) => createHash("sha256").update(text).digest("hex");
try {
  await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
  await fs.writeFile(path.join(packageRoot, "package.json"), '{"type":"module"}\n');
  const files: string[] = [];
  const expected: string[] = [];
  const hashes = new Map<string, string>();
  const chunks: Record<string, { sha256: string; extensions: string[] }> = {};
  const omitted = new Set(Array.from({ length: 30 }, (_, index) => `plugin-${index}`));
  const write = async (name: string, source: string) => {
    files.push(`dist/${name}`);
    hashes.set(`dist/${name}`, digest(source));
    await fs.writeFile(path.join(packageRoot, "dist", name), source);
  };
  // An aliased native require retains an otherwise omitted chunk and its transitive import.
  await write(
    "entry.mjs",
    'import { createRequire } from "node:module"; const load = createRequire(import.meta.url); load("./plugin-0-0.mjs");\n',
  );
  expected.push("dist/entry.mjs");
  for (let plugin = 0; plugin < 40; plugin++) {
    for (let chunk = 0; chunk < 4; chunk++) {
      const name = `plugin-${plugin}-${chunk}.mjs`;
      const source =
        (plugin === 0 && chunk === 0 ? 'import "./plugin-0-1.mjs";\n' : "") +
        Array.from(
          { length: 48 },
          (_, index) =>
            `export function value${index}(input) { const result = input.map(item => ({ name: item.name, value: item.value + ${index} })); return result.filter(item => item.value > 0); }`,
        ).join("\n");
      await write(name, source);
      chunks[name] = { sha256: digest(source), extensions: [`plugin-${plugin}`] };
      if (plugin >= 30 || (plugin === 0 && chunk < 2)) {
        expected.push(`dist/${name}`);
      }
    }
  }
  await fs.writeFile(
    path.join(packageRoot, "dist/runtime-dependency-ownership.json"),
    JSON.stringify({ chunks }),
  );
  const prepare = () => resolveChunks(packageRoot, files, ["dist/"], omitted);
  const summarize = (result: Awaited<ReturnType<typeof prepare>>) => {
    assert.deepEqual(result.files, expected);
    return digest(
      JSON.stringify(
        result.files.map((file) => ({
          file,
          sha256: hashes.get(file),
          imports: result.sourceFacts.get(file)?.imports ?? [],
        })),
      ),
    );
  };
  const manifestHash = summarize(await prepare());
  global.gc();
  await nextTurn();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 32768,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  observer.observe({ entryTypes: ["gc"] });
  const before = { memory: process.memoryUsage(), load: loadavg() };
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let iteration = 0; iteration < iterations; iteration++) {
    assert.equal(summarize(await prepare()), manifestHash);
  }
  const elapsedMs = performance.now() - start;
  const used = process.cpuUsage(cpu);
  await nextTurn();
  observer.disconnect();
  const gcMs = pauses.reduce((sum, pause) => sum + pause, 0);
  let sampledBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    sampledBytes = 0;
    const pending = [profile.head];
    for (const node of pending) {
      sampledBytes += node.selfSize;
      pending.push(...node.children);
    }
  }
  const result = {
    iterations,
    inputFilesPerPreparation: files.length,
    selectedFiles: expected.length,
    manifestHash,
    elapsedMs,
    cpuMsPerPreparation: (used.user + used.system) / 1000 / iterations,
    sampledBytesPerPreparation: sampledBytes === undefined ? undefined : sampledBytes / iterations,
    gcMs,
    gcSecondsPerMinute: (gcMs / elapsedMs) * 60,
    gcCollections: pauses.length,
    maxGcPauseMs: Math.max(0, ...pauses),
    maxRssKiB: process.resourceUsage().maxRSS,
    before,
    after: { memory: process.memoryUsage(), load: loadavg() },
  };
  await fs.writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result));
} finally {
  observer.disconnect();
  if (values.allocations) {
    inspector.disconnect();
  }
  await fs.rm(packageRoot, { recursive: true, force: true });
}
