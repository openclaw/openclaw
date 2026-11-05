/**
 * Synthetic package-store capture and staging through the real owners.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-store-staging-measure.ts prepare .local/store-proof
 * [OPENCLAW_BENCH_BASELINE_DIR=<sparse original source>] node --expose-gc --import ./scripts/tsx.mjs scripts/perf/workspace-store-staging-measure.ts run .local/store-proof <label> [timing|allocation|cpu]
 * Run same-source A/A controls, then five interleaved A/B samples; allocation and
 * CPU profiles are separate passes. Both arms share immutable synthetic files.
 * Capture is cold owner state, not cold OS cache. No database, engine or Gateway
 * is involved: these owners read files and produce Git fast-import inputs.
 * Acceptance: identical authored bytes; exclude store bytes before the staged
 * limit; reduce capture hashes/bytes and normal stage writes without regression.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import os from "node:os";
import path from "node:path";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";

const [mode, directory, label = "sample", instrument = "timing"] = process.argv.slice(2);
assert.ok(directory && ["prepare", "run"].includes(mode ?? ""));
assert.ok(["timing", "allocation", "cpu"].includes(instrument));
const scratch = path.resolve(directory);
const root = path.join(scratch, "workspace");
const store = "artifacts/task-environment/local/share/pnpm/store/v11/files";
const sourceFiles = 2_000;
const storeFiles = 60_000;
const fileBytes = 19_050;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const filename = (index: number, prefix: string) =>
  `${prefix}/${String(Math.floor(index / 100)).padStart(3, "0")}/${String(index).padStart(5, "0")}`;
if (mode === "prepare") {
  await fs.mkdir(scratch, { recursive: true });
  await fs.mkdir(root);
  const content = Buffer.alloc(fileBytes, "synthetic package contents\n");
  for (const [prefix, count] of [
    ["source", sourceFiles],
    [store, storeFiles],
  ] as const) {
    for (let index = 0; index < count; index++) {
      const destination = path.join(root, filename(index, prefix));
      if (index % 100 === 0) {
        await fs.mkdir(path.dirname(destination), { recursive: true });
      }
      content.write(String(index).padStart(8, "0"), 0, "ascii");
      await fs.writeFile(destination, content);
    }
  }
  console.log(
    JSON.stringify({
      root,
      files: sourceFiles + storeFiles,
      logicalBytes: (sourceFiles + storeFiles) * fileBytes,
    }),
  );
} else {
  assert.ok(global.gc, "requires --expose-gc");
  if (process.env.OPENCLAW_BENCH_BASELINE_DIR) {
    await import("./worker-retained-heap-preload.js");
  }
  const { readActualWorkspaceManifestImpl } =
    await import("../../src/gateway/worker-environments/workspace-actual-manifest.js");
  const { withWorkspaceHashMemo } =
    await import("../../src/gateway/worker-environments/workspace-hash-memo.js");
  const { buildWorkspaceStageInput } =
    await import("../../src/gateway/worker-environments/workspace-result-preparation.runtime.js");
  const { serializeWorkerWorkspaceManifest } =
    await import("../../src/gateway/worker-environments/workspace-manifest.js");
  const baseline = Boolean(process.env.OPENCLAW_BENCH_BASELINE_DIR);
  const metrics = { contentHashCount: 0, memoHitCount: 0 };
  const inspector = new Session();
  global.gc();
  if (instrument === "allocation") {
    await startCollectedHeapSampling(inspector, 32_768);
  }
  if (instrument === "cpu") {
    inspector.connect();
    await inspector.post("Profiler.enable");
    await inspector.post("Profiler.start");
  }
  const memoryBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();
  const started = performance.now();
  const captured = await withWorkspaceHashMemo(
    new Map(),
    () => readActualWorkspaceManifestImpl({ root, baseCommit: null }),
    metrics,
  );
  const captureMs = performance.now() - started;
  assert.equal(captured.manifest.entries.length, sourceFiles + (baseline ? storeFiles : 0));
  const authored = captured.manifest.entries.filter((entry) => entry.path.startsWith("source/"));
  assert.equal(authored.length, sourceFiles);
  const authoredDigest = hash(JSON.stringify(authored));
  const stage = async (threshold: boolean) => {
    const inputPath = path.join(
      scratch,
      `${label}-${threshold ? "threshold" : "normal"}.fast-import`,
    );
    const base = threshold
      ? { ...captured.manifest, entries: [], directories: [] }
      : {
          ...captured.manifest,
          // One authored edit and 1,000 newly downloaded store files; other bytes
          // already belong to the accepted synthetic baseline.
          entries: captured.manifest.entries.filter(
            (entry) =>
              entry.path !== filename(0, "source") &&
              !(
                entry.path.startsWith(store + "/") &&
                Number(path.posix.basename(entry.path)) < 1_000
              ),
          ),
        };
    const baseRaw = serializeWorkerWorkspaceManifest(base);
    const stageStarted = performance.now();
    let error: string | undefined;
    try {
      await buildWorkspaceStageInput({
        inputPath,
        stagingRoot: root,
        stagedResultRef: "refs/openclaw/worker-results/synthetic-store",
        baseManifestRef: `sha256:${hash(baseRaw)}`,
        currentManifestRef: captured.manifestRef,
        baseManifestRaw: new TextEncoder().encode(baseRaw),
        currentManifestRaw: new TextEncoder().encode(captured.rawManifest),
      });
    } catch (failure) {
      error = String(failure);
      assert.ok(
        threshold &&
          baseline &&
          error.includes("Cloud workspace staged result exceeds its byte limit"),
        error,
      );
    }
    const elapsedMs = performance.now() - stageStarted;
    assert.equal(Boolean(error), threshold && baseline);
    const writtenBytes = (await fs.stat(inputPath).catch(() => undefined))?.size ?? 0;
    await fs.rm(inputPath, { force: true });
    return {
      elapsedMs,
      writtenBytes,
      error,
      payloadBytes: error
        ? 0
        : threshold
          ? sourceFiles * fileBytes
          : (1 + (baseline ? 1_000 : 0)) * fileBytes,
    };
  };
  const normal = await stage(false);
  const threshold = await stage(true);
  const elapsedMs = performance.now() - started;
  const used = process.cpuUsage(cpuBefore);
  let allocatedBytes: number | undefined;
  if (instrument === "allocation") {
    const { profile } = await inspector.post("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, entry) => sum + entry.size, 0);
  }
  if (instrument === "cpu") {
    const { profile } = await inspector.post("Profiler.stop");
    await fs.writeFile(path.join(scratch, `${label}.cpuprofile`), JSON.stringify(profile));
  }
  if (instrument !== "timing") {
    inspector.disconnect();
  }
  const result = {
    label,
    baseline,
    instrument,
    node: process.version,
    platform: process.platform,
    load: os.loadavg(),
    fixtureFiles: sourceFiles + storeFiles,
    fixtureLogicalBytes: (sourceFiles + storeFiles) * fileBytes,
    captureMs,
    elapsedMs,
    cpuMs: (used.user + used.system) / 1_000,
    allocatedBytes,
    capturedFiles: captured.manifest.entries.length,
    capturedLogicalBytes: captured.manifest.entries.reduce(
      (sum, entry) => sum + (entry.type === "file" ? entry.size : 0),
      0,
    ),
    manifestBytes: Buffer.byteLength(captured.rawManifest),
    authoredDigest,
    metrics,
    normal,
    threshold,
    physicalBytesWritten: null,
    memoryBefore,
    memoryAfter: process.memoryUsage(),
  };
  await fs.writeFile(path.join(scratch, `${label}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
}
