/**
 * Real worker-backed baseline replacement with a one-file edit, alternating two documents.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/local-workspace-transport.ts
 *   [--files 10000|100000|repo] [--iterations 5] [--allocation]
 * Run unchanged on each revision; use separate allocation passes. Synthetic file contents,
 * repository path names only, isolated state, no Gateway listener or model. The main-thread
 * timers include the real broker's serialization; tree construction/compression runs in workers.
 * Acceptance: identical final root and rows, fewer preparation bytes/requests, lower main CPU
 * and sampled allocation, without a consistent end-to-end CPU or latency regression.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { Session } from "node:inspector/promises";
import { syncBuiltinESMExports } from "node:module";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { PerformanceObserver } from "node:perf_hooks";
import { setImmediate as immediate } from "node:timers/promises";
import { parseArgs } from "node:util";
import v8 from "node:v8";
import zlib from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { LocalWorkspacePreparation } from "../../src/gateway/worker-environments/local-workspace-cas.js";

const { values } = parseArgs({
  options: {
    files: { type: "string", default: "10000" },
    iterations: { type: "string", default: "5" },
    allocation: { type: "boolean", default: false },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
assert(global.gc, "Run with --expose-gc");
const paths =
  values.files === "repo"
    ? execFileSync("git", ["ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
        .split("\0")
        .filter(Boolean)
    : Array.from(
        { length: Number(values.files) },
        (_, i) => `src/d${Math.floor(i / 100)}/f${i}.ts`,
      );
assert(paths.length > 0);
const directories = new Set<string>();
for (const file of paths) {
  for (let dir = path.posix.dirname(file); dir !== "."; dir = path.posix.dirname(dir)) {
    directories.add(dir);
  }
}
const { serializeWorkerWorkspaceManifest } =
  await import("../../src/gateway/worker-environments/workspace-manifest.js");
const documents = ["b", "c"].map((hash) => {
  const rawManifest = serializeWorkerWorkspaceManifest({
    version: 1,
    baseCommit: "a".repeat(40),
    entries: paths.map((file, index) => ({
      path: file,
      type: "file",
      mode: 0o644,
      size: 1,
      sha256: (index === 0 ? hash : "d").repeat(64),
    })),
    directories: [...directories],
  });
  return {
    rawManifest,
    manifestRef: `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`,
    buildCacheInputs: [],
  };
});
let active = false;
let serializeMs = 0;
let serializeBytes = 0;
let deflateMs = 0;
let inflateMs = 0;
let deserializeMs = 0;
const commands: Record<string, { count: number; bytes: number }> = {};
let preparationDiagnostic: { packs: number; rawBytes: number; compressedBytes: number } | undefined;
const originalSerialize = v8.serialize;
v8.serialize = (value: unknown) => {
  const start = performance.now();
  const result = originalSerialize(value);
  if (
    preparationDiagnostic &&
    isRecord(value) &&
    value.type === "localWorkspace.prepare" &&
    isRecord(value.input) &&
    value.input.preparation instanceof Uint8Array
  ) {
    const raw = originalInflate(value.input.preparation);
    // SAFETY: The production workspace owner made this preparation; diagnostic pass only.
    const preparation = originalDeserialize(raw) as LocalWorkspacePreparation;
    preparationDiagnostic.packs += preparation.packs?.length ?? 0;
    preparationDiagnostic.rawBytes += raw.byteLength;
    preparationDiagnostic.compressedBytes += value.input.preparation.byteLength;
  }
  if (active) {
    serializeMs += performance.now() - start;
    serializeBytes += result.byteLength;
    if (
      isRecord(value) &&
      typeof value.type === "string" &&
      value.type.startsWith("localWorkspace.")
    ) {
      const entry = (commands[value.type] ??= { count: 0, bytes: 0 });
      entry.count++;
      entry.bytes += result.byteLength;
    }
  }
  return result;
};
const originalDeserialize = v8.deserialize;
v8.deserialize = (...args) => {
  const start = performance.now();
  const result = originalDeserialize(...args);
  if (active) {
    deserializeMs += performance.now() - start;
  }
  return result;
};
const originalDeflate = zlib.deflateRawSync;
zlib.deflateRawSync = (...args) => {
  const start = performance.now();
  const result = originalDeflate(...args);
  if (active) {
    deflateMs += performance.now() - start;
  }
  return result;
};
const originalInflate = zlib.inflateRawSync;
zlib.inflateRawSync = (...args) => {
  const start = performance.now();
  const result = originalInflate(...args);
  if (active) {
    inflateMs += performance.now() - start;
  }
  return result;
};
syncBuiltinESMExports();
const { withLocalWorkspaceStore } =
  await import("../../src/gateway/worker-environments/local-workspace-store.js");
const { closeOpenClawStateDatabaseAsync, openOpenClawStateDatabase } =
  await import("../../src/state/openclaw-state-db.js");
// Only the state directory needs the safe default temp root; no corpus is materialized.
const root = fs.mkdtempSync(path.join(tmpdir(), "workspace-transport-"));
const env = { ...process.env, OPENCLAW_STATE_DIR: root };
const inspector = new Session();
const windows: Array<{ start: number; end: number }> = [];
const collections: Array<{ start: number; duration: number }> = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries()) {
    collections.push({ start: entry.startTime, duration: entry.duration });
  }
});
observer.observe({ entryTypes: ["gc"] });
try {
  await withLocalWorkspaceStore({ worktreeId: "synthetic", env }, async (store) => {
    await store.create({
      worktree_id: "synthetic",
      agent_id: "main",
      session_key: "synthetic",
      session_id: "synthetic",
      lifecycle_revision: null,
      projection_path: path.join(root, "workspace"),
      base_commit: "a".repeat(40),
      source_paths_json: "[]",
      baseline_json: null,
      baseline_ref: null,
      tree_root_digest: null,
      source_paths_digest: null,
      canonical_fingerprints: null,
      projection_fingerprints: null,
      checkpoint_json: null,
      pending_ref: null,
      pending_target: null,
      journal_json: null,
      journal_pack: null,
      paused_runtimes_json: null,
      created_at_ms: 1,
    });
    await store.update(store.get()!, {}, undefined, documents[0]!);
    await immediate();
    global.gc!();
    const hostLoad = loadavg();
    if (values.allocation) {
      inspector.connect();
      await inspector.post("HeapProfiler.startSampling", {
        samplingInterval: 32768,
        includeObjectsCollectedByMajorGC: true,
        includeObjectsCollectedByMinorGC: true,
      });
    }
    const samples = [];
    for (let i = 0; i < iterations; i++) {
      const cpu = process.threadCpuUsage();
      const totalCpu = process.cpuUsage();
      const start = performance.now();
      active = true;
      const row = await store.update(store.get()!, {}, undefined, documents[(i + 1) % 2]!);
      active = false;
      const end = performance.now();
      const mainUsed = process.threadCpuUsage(cpu);
      const totalUsed = process.cpuUsage(totalCpu);
      windows.push({ start, end });
      samples.push({
        wallMs: end - start,
        mainCpuMs: (mainUsed.user + mainUsed.system) / 1000,
        processCpuMs: (totalUsed.user + totalUsed.system) / 1000,
        memory: process.memoryUsage(),
        root: row.baseline_ref,
      });
    }
    let allocationBytes: number | undefined;
    if (values.allocation) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
      inspector.disconnect();
    }
    await immediate();
    // Inspect a separate, untimed refresh so decoding instrumentation cannot affect the samples.
    preparationDiagnostic = { packs: 0, rawBytes: 0, compressedBytes: 0 };
    await store.update(store.get()!, {}, undefined, documents[(iterations + 1) % 2]!);
    const db = openOpenClawStateDatabase({ env }).db;
    const storedPacks = db
      .prepare(
        "SELECT hex(tree_digest) AS digest, records_json, children_json FROM local_workspace_tree_packs ORDER BY tree_digest",
      )
      .all();
    const storedPayloadHash = createHash("sha256")
      .update(JSON.stringify(storedPacks))
      .digest("hex");
    const gc = collections.filter((entry) =>
      windows.some((window) => entry.start >= window.start && entry.start < window.end),
    );
    console.log(
      JSON.stringify({
        files: paths.length,
        directories: directories.size,
        iterations,
        storedPayloadHash,
        preparationDiagnostic,
        hostLoad,
        samples,
        allocationBytes,
        serializeMs,
        serializeBytes,
        deflateMs,
        inflateMs,
        deserializeMs,
        commands,
        gcMs: gc.reduce((sum, entry) => sum + entry.duration, 0),
        gcCount: gc.length,
        maxGcMs: Math.max(0, ...gc.map((entry) => entry.duration)),
      }),
    );
  });
} finally {
  active = false;
  observer.disconnect();
  await closeOpenClawStateDatabaseAsync();
  fs.rmSync(root, { recursive: true, force: true });
}
