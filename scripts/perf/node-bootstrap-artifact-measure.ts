/**
 * Measure one real bootstrap preparation against an already-built source checkout on Linux.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/node-bootstrap-artifact-measure.ts \
 *   --package-root /absolute/built/gateway --output /absolute/new-run
 * Add --plugins id,id for explicitly selected plugins, --prebuilt to permit archive reuse,
 * or --allocations for a separate sampled-allocation pass (never compare traced timings).
 * Repeat baseline/candidate in alternating order at least three times each. Acceptance:
 * identical archive and manifest hashes, lower peak RSS/allocation, no adverse CPU change.
 * A parent samples /proc RSS every 100 ms even during synchronous parsing in the child.
 * This measures the artifact owner, not whole-Gateway startup or the install-lock resolver.
 */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { performance, PerformanceObserver } from "node:perf_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "package-root": { type: "string" },
    module: { type: "string" },
    output: { type: "string" },
    plugins: { type: "string", default: "" },
    prebuilt: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    child: { type: "boolean", default: false },
  },
});
assert(values["package-root"] && values.output, "--package-root and --output are required");
assert.equal(process.platform, "linux", "RSS sampler requires Linux /proc");
assert(global.gc, "Run with --expose-gc");
const output = path.resolve(values.output);
const packageRoot = await fs.realpath(values["package-root"]);

if (!values.child) {
  await fs.mkdir(output);
  const child = fork(fileURLToPath(import.meta.url), [...process.argv.slice(2), "--child"]);
  const rssSamples: Array<{ elapsedMs: number; rssKiB: number }> = [];
  let start: number | undefined;
  let pending = Promise.resolve();
  const sample = () => {
    pending = pending.then(async () => {
      if (start === undefined) {
        return;
      }
      const status = await fs.readFile(`/proc/${child.pid}/status`, "utf8").catch(() => "");
      const rss = /^VmRSS:\s+(\d+)/m.exec(status);
      if (rss && start !== undefined) {
        rssSamples.push({ elapsedMs: performance.now() - start, rssKiB: Number(rss[1]) });
      }
    });
  };
  child.on("message", (message) => {
    if (message === "start") {
      start = performance.now();
      sample();
    } else if (message === "stop") {
      start = undefined;
    }
  });
  const timer = setInterval(sample, 100);
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    assert.equal(code, 0, "Preparation child failed");
  } finally {
    clearInterval(timer);
    await pending;
    await fs.writeFile(path.join(output, "rss-samples.json"), JSON.stringify(rssSamples));
  }
} else {
  const moduleUrl = values.module
    ? pathToFileURL(path.resolve(values.module))
    : new URL(
        "../../src/gateway/worker-environments/node-bootstrap-artifact-build.ts",
        import.meta.url,
      );
  const {
    prepareNodeBootstrapArtifact,
  }: typeof import("../../src/gateway/worker-environments/node-bootstrap-artifact-build.js") =
    await import(moduleUrl.href);
  const preparationSourceSha256 = createHash("sha256")
    .update(await fs.readFile(moduleUrl))
    .digest("hex");
  const { readWorkerBundleArchiveManifest, DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS } =
    await import("../../src/shared/worker-bundle-archive.js");
  const { hashWorkerBundleManifest } = await import("../../src/shared/worker-bundle-hash.js");
  const buildInfo = JSON.parse(
    await fs.readFile(path.join(packageRoot, "dist/build-info.json"), "utf8"),
  );
  const temporaryRoot = path.join(output, "artifact");
  await fs.mkdir(temporaryRoot);
  const plugins = values.plugins
    .split(",")
    .filter(Boolean)
    .map((id) => ({
      id,
      root: path.join(packageRoot, "extensions", id),
    }));
  const inspector = new Session();
  const pauses: Array<{ duration: number; kind: number }> = [];
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const detail = entry.toJSON().detail as { kind: number };
      pauses.push({ duration: entry.duration, kind: detail.kind });
    }
  });
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
  process.send?.("start");
  const cpu = process.cpuUsage();
  const start = performance.now();
  try {
    const artifact = await prepareNodeBootstrapArtifact(
      { packageRoot, runningBuildId: buildInfo.buildId, plugins },
      temporaryRoot,
      values.prebuilt,
    );
    const elapsedMs = performance.now() - start;
    const used = process.cpuUsage(cpu);
    const after = { memory: process.memoryUsage(), load: loadavg() };
    const maxRssKiB = process.resourceUsage().maxRSS;
    process.send?.("stop");
    await nextTurn();
    observer.disconnect();
    let sampledBytes: number | undefined;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      sampledBytes = 0;
      const pending = [profile.head];
      for (const node of pending) {
        sampledBytes += node.selfSize;
        pending.push(...node.children);
      }
      await fs.writeFile(path.join(output, "allocation-profile.json"), JSON.stringify(profile));
    }
    // Verification is outside the measured preparation and RSS sampling window.
    const manifest = await readWorkerBundleArchiveManifest(
      artifact.tarballPath,
      DEFAULT_WORKER_BUNDLE_ARCHIVE_LIMITS,
    );
    const result = {
      ...artifact,
      preparationSourceSha256,
      manifestHash: hashWorkerBundleManifest(manifest),
      files: manifest.length,
      expandedBytes: manifest.reduce((sum, entry) => sum + entry.size, 0),
      elapsedMs,
      cpuMs: (used.user + used.system) / 1000,
      sampledBytes,
      maxRssKiB,
      gcMs: pauses.reduce((sum, entry) => sum + entry.duration, 0),
      pauses,
      before,
      after,
    };
    await fs.writeFile(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result));
  } finally {
    observer.disconnect();
    if (values.allocations) {
      inspector.disconnect();
    }
    process.disconnect?.();
  }
}
