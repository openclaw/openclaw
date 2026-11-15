/**
 * Real synchronous source-capture owner, 40 synthetic packages with 24 files each.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-capture-stat-measure.ts
 *   --dist /absolute/build/dist --iterations 2000 [--allocations]
 * Compare built revisions in AB/BA order; allocations use a separate sampled pass.
 * Includes capture and disposal, excludes fixture creation, imports and warmup.
 * Gateway readiness is measured separately with bench-gateway-startup.ts --case teamBoot.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    dist: { type: "string", default: "dist" },
    iterations: { type: "string", default: "2000" },
    allocations: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
fs.mkdirSync(".local", { recursive: true });
const root = fs.realpathSync(fs.mkdtempSync(path.resolve(".local/plugin-capture-stat-")));
process.env.OPENCLAW_STATE_DIR = path.join(root, "state");
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "absent-config.json");
const inspector = new Session();
try {
  const dist = path.resolve(values.dist);
  const filename = fs
    .readdirSync(dist)
    .find((name) => /^plugin-generation-artifact-.*\.mjs$/.test(name));
  assert(filename, "Build the runtime first");
  const exports = await import(pathToFileURL(path.join(dist, filename)).href);
  const capture = Object.values(exports).find(
    (value) => typeof value === "function" && value.name === "capturePluginGenerationArtifact",
  ) as typeof import("../../src/plugins/plugin-generation-artifact.js").capturePluginGenerationArtifact;
  assert.equal(typeof capture, "function");
  const packages = Array.from({ length: 40 }, (_, index) => {
    const directory = path.join(root, `plugin-${index}`);
    fs.mkdirSync(path.join(directory, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(directory, "package.json"),
      JSON.stringify({ name: `fixture-${index}` }),
    );
    for (let file = 0; file < 24; file++) {
      fs.writeFileSync(
        path.join(directory, "assets", `${file}.txt`),
        `fixture-${index}-${file}\n`.repeat(20),
      );
    }
    return directory;
  });
  let checksum = 0;
  const run = (count: number) => {
    for (let index = 0; index < count; index++) {
      const directory = packages[index % packages.length]!;
      const artifact = capture(directory, undefined, (work) => work());
      try {
        checksum += artifact.sourceDigest.length;
        if (index === 0) {
          assert.equal(
            fs.readFileSync(artifact.resolve(path.join(directory, "assets", "0.txt")), "utf8"),
            "fixture-0-0\n".repeat(20),
          );
        }
      } finally {
        artifact.dispose();
      }
    }
  };
  run(40);
  global.gc();
  if (values.allocations) {
    inspector.connect();
    await inspector.post("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  const hostLoad = loadavg();
  const cpuStart = process.threadCpuUsage();
  const start = performance.now();
  run(iterations);
  const wallMs = performance.now() - start;
  const cpu = process.threadCpuUsage(cpuStart);
  const sampledBytes = values.allocations
    ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
        (sum, sample) => sum + sample.size,
        0,
      )
    : undefined;
  console.log(
    JSON.stringify({
      dist,
      iterations,
      packages: packages.length,
      filesPerPackage: 25,
      hostLoad,
      hostLoadEnd: loadavg(),
      wallMs,
      cpuUsPerCapture: values.allocations ? undefined : (cpu.user + cpu.system) / iterations,
      sampledBytesPerCapture: sampledBytes === undefined ? undefined : sampledBytes / iterations,
      memory: process.memoryUsage(),
      checksum,
    }),
  );
} finally {
  inspector.disconnect();
  fs.rmSync(root, { recursive: true, force: true });
}
