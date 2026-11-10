/**
 * Real scratch filesystem owner, synthetic files only. Fixture creation and verification are
 * outside measurement. Baseline has no scratch owner and reclaims nothing; it is not a speed
 * comparator. A1/A2 are same-code candidate controls on freshly recreated eligible entries.
 *
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/scratch-cleanup-measure.ts \
 *   --root /absolute/new/evidence-directory --samples 5 --mode timing
 * Repeat with a new root and --mode allocation; --mode profile writes one CPU profile.
 * Acceptance: reclaim every expired entry, preserve fresh/live/outside files, bounded paced
 * deletion. Report added CPU/allocation cost and A/A spread; do not claim a Gateway speedup.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { availableParallelism, loadavg, totalmem } from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import {
  cleanScratch,
  closeScratchCleanupCursor,
  type ScratchCleanupResult,
} from "../../src/infra/scratch-cleanup.js";
import { startCollectedHeapSampling } from "../lib/heap-sampling.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    samples: { type: "string", default: "5" },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "19050" },
    mode: { type: "string", default: "timing" },
  },
});
assert(values.root, "--root must name a new synthetic evidence directory");
assert(globalThis.gc, "Run with --expose-gc");
assert(["timing", "allocation", "profile"].includes(values.mode));
const integer = (key: "samples" | "files" | "file-bytes", min: number) =>
  parseStrictIntegerOption({ raw: values[key], label: `--${key}`, min, fallback: min });
const samples = values.mode === "profile" ? 1 : integer("samples", 1);
const fileCount = integer("files", 100);
const fileBytes = integer("file-bytes", 1);
await fs.mkdir(path.resolve(values.root));
const root = await fs.realpath(values.root);
const checkout = path.join(root, "fixture", "checkout");
const liveCheckout = path.join(root, "fixture", "live-checkout");
const runtime = path.join(root, "fixture", "runtime-temp");
const now = Date.now();
const old = new Date(now - 25 * 60 * 60 * 1000);
const fresh = new Date(now - 60 * 60 * 1000);
const liveFiles = Math.floor(fileCount * 0.2);
const freshFiles = Math.floor(fileCount * 0.2);
const coverageFiles = Math.floor(fileCount / 31);
const expiredFiles = fileCount - liveFiles - freshFiles - coverageFiles;
const expired = path.join(checkout, ".openclaw/tmp/expired-proof");
const coverage = path.join(runtime, "node-coverage-synthetic");
const freshProof = path.join(checkout, ".openclaw/tmp/fresh-proof");
const liveProof = path.join(liveCheckout, ".openclaw/tmp/live-proof");
const payload = Buffer.alloc(fileBytes);
for (let offset = 0; offset < payload.length; offset += 32) {
  createHash("sha256")
    .update(`synthetic-scratch-block:${offset}`)
    .digest()
    .copy(payload, offset, 0, Math.min(32, payload.length - offset));
}
const fixtureCounts = { expiredFiles, coverageFiles, freshFiles, liveFiles };
const reclaimedBytes = (expiredFiles + coverageFiles) * fileBytes;

async function populate(directory: string, count: number, mtime: Date) {
  await fs.mkdir(directory, { recursive: true });
  // Bounded setup concurrency is outside all owner measurements.
  for (let offset = 0; offset < count; offset += 16) {
    await Promise.all(
      Array.from({ length: Math.min(16, count - offset) }, async (_, index) => {
        const file = path.join(directory, `${offset + index}.proof`);
        await fs.writeFile(file, payload);
        await fs.utimes(file, mtime, mtime);
      }),
    );
  }
}

await populate(freshProof, freshFiles, fresh);
await populate(liveProof, liveFiles, old);
const outside = path.join(checkout, "keep-source.txt");
await fs.writeFile(outside, "synthetic source, outside scratch");
const filesystem = await fs.statfs(root);
const metadata = {
  scope:
    "scratch filesystem owner only; no agent DB, session binding preparation, or Gateway transport",
  fixture: {
    ...fixtureCounts,
    files: fileCount,
    logicalBytes: fileCount * fileBytes,
    fileBytes,
    payload: "deterministic SHA-256 blocks; byte removal counts are logical, not allocated extents",
  },
  host: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    cpus: availableParallelism(),
    memoryBytes: totalmem(),
    filesystemType: filesystem.type.toString(16),
    btrfs: filesystem.type === 0x9123683e,
  },
  ownerSha256: createHash("sha256")
    .update(await fs.readFile(new URL("../../src/infra/scratch-cleanup.ts", import.meta.url)))
    .digest("hex"),
  mode: values.mode,
  acceptance:
    "Every expired file removed; fresh/live/outside files preserved; added owner cost and A/A spread reported, no speedup claim",
};
await fs.writeFile(path.join(root, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);
console.log(JSON.stringify({ metadata }));
const rows: Record<string, unknown>[] = [];
try {
  for (let sample = 0; sample < samples; sample++) {
    for (const label of values.mode === "profile" ? ["candidate"] : ["A1", "A2"]) {
      await populate(expired, expiredFiles, old);
      await populate(coverage, coverageFiles, old);
      for (const variant of ["baseline", "candidate"]) {
        globalThis.gc();
        const inspector = new Session();
        if (values.mode === "allocation") {
          await startCollectedHeapSampling(inspector, 32768);
        } else if (values.mode === "profile" && variant === "candidate") {
          inspector.connect();
          await inspector.post("Profiler.enable");
          await inspector.post("Profiler.start");
        }
        let pauses = 0;
        let pacingMs = 0;
        let liveChecks = 0;
        const isIdle = () => {
          liveChecks++;
          return false;
        };
        const isLive = () => {
          liveChecks++;
          return true;
        };
        const loop = monitorEventLoopDelay({ resolution: 10 });
        loop.enable();
        const hostLoad = loadavg();
        const cpu = process.cpuUsage();
        const threadCpu = process.threadCpuUsage();
        const started = performance.now();
        let result: ScratchCleanupResult | undefined;
        if (variant === "candidate") {
          const cursor = {};
          try {
            result = await cleanScratch({
              targets: [
                { root: checkout, kind: "checkout", isLive: isIdle },
                { root: liveCheckout, kind: "checkout", isLive },
                { root: runtime, kind: "coverage", isLive: isIdle },
              ],
              now,
              assertCurrent: () => {},
              pause: async (milliseconds) => {
                pauses++;
                pacingMs += milliseconds;
                await delay(milliseconds);
              },
              cursor,
            });
          } finally {
            await closeScratchCleanupCursor(cursor);
          }
        }
        const elapsedMs = performance.now() - started;
        const usedCpu = process.cpuUsage(cpu);
        const usedThreadCpu = process.threadCpuUsage(threadCpu);
        loop.disable();
        const allocatedBytes =
          values.mode === "allocation"
            ? (await inspector.post("HeapProfiler.stopSampling")).profile.samples.reduce(
                (sum, entry) => sum + entry.size,
                0,
              )
            : undefined;
        if (values.mode === "profile" && variant === "candidate") {
          const { profile } = await inspector.post("Profiler.stop");
          await fs.writeFile(path.join(root, "owner.cpuprofile"), JSON.stringify(profile));
        }
        inspector.disconnect();
        const row = {
          sample,
          label,
          variant,
          elapsedMs,
          allocatedBytes,
          cpuMs: (usedCpu.user + usedCpu.system) / 1000,
          mainThreadCpuMs: (usedThreadCpu.user + usedThreadCpu.system) / 1000,
          maxEventLoopDelayMs: loop.max / 1e6,
          hostLoad,
          pauses,
          pacingMs,
          liveChecks,
          bytesRemoved: result?.bytesRemoved ?? 0,
          result,
        };
        rows.push(row);
        await fs.appendFile(path.join(root, "samples.jsonl"), `${JSON.stringify(row)}\n`);
        console.log(JSON.stringify(row));
        if (variant === "candidate") {
          assert.equal(result?.bytesRemoved, reclaimedBytes);
          assert.equal(result?.entriesRemoved, 2);
          assert.equal(result?.skippedLive, 1);
          assert.deepEqual(result?.errors, []);
          await assert.rejects(fs.stat(expired), { code: "ENOENT" });
          await assert.rejects(fs.stat(coverage), { code: "ENOENT" });
        }
        assert.equal((await fs.readdir(freshProof)).length, freshFiles);
        assert.equal((await fs.readdir(liveProof)).length, liveFiles);
        assert.equal(await fs.readFile(outside, "utf8"), "synthetic source, outside scratch");
      }
    }
  }
  await fs.writeFile(
    path.join(root, "results.json"),
    `${JSON.stringify({ metadata, rows }, null, 2)}\n`,
  );
} finally {
  await fs.rm(path.join(root, "fixture"), { recursive: true, force: true });
}
