/**
 * Synthetic filesystem proof of the actual retired-cleanup entrypoint.
 * node --import ./scripts/tsx.mjs scripts/perf/retired-worktree-unlink-measure.ts \
 *   --output <new-directory> [--worker <pinned-baseline-worker.ts>]
 * Run A/A controls then five serial A/B pairs. Real 100 ms waits remain enabled.
 * Acceptance: <=128 entries / <=8 MiB per ordinary burst, >=100 ms between bursts,
 * complete deletion in minutes. One oversized file is an indivisible batch.
 * Counters measure apparent bytes and calls, not btrfs physical delayed refs.
 * CPU/allocation include instrumentation; fixture creation is outside timing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import timers from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    worker: { type: "string" },
    files: { type: "string", default: "62000" },
    "file-bytes": { type: "string", default: "18432" },
  },
});
assert(values.output);
const output = path.resolve(values.output);
const files = Number(values.files);
const fileBytes = Number(values["file-bytes"]);
assert([files, fileBytes].every((n) => Number.isSafeInteger(n) && n > 0));
fs.mkdirSync(output);
const retired = path.join(output, "retired");
fs.mkdirSync(retired);
const sizes = new Map<string, number>([[retired, 0]]);
const content = Buffer.alloc(fileBytes, 97);
for (let index = 0; index < files; index++) {
  const directory = path.join(retired, String(Math.floor(index / 100)));
  if (index % 100 === 0) {
    fs.mkdirSync(directory);
    sizes.set(directory, 0);
  }
  const file = path.join(directory, String(index));
  fs.writeFileSync(file, content);
  sizes.set(file, fileBytes);
}
const entryCount = sizes.size;
const batches: { entries: number; bytes: number; pauseMs: number; actualPauseMs: number }[] = [];
let entries = 0;
let bytes = 0;
const unlink = fs.unlinkSync;
const rmdir = fs.rmdirSync;
const rm = fs.rmSync;
const sleep = timers.setTimeout;
const count = (target: fs.PathLike) => {
  const name = String(target);
  assert(sizes.has(name), `Unexpected deletion: ${name}`);
  entries++;
  bytes += sizes.get(name)!;
  sizes.delete(name);
};
fs.unlinkSync = (target) => {
  unlink(target);
  count(target);
};
fs.rmdirSync = (target) => {
  rmdir(target);
  count(target);
};
fs.rmSync = (target, options) => {
  assert.equal(String(target), retired);
  rm(target, options);
  // Node's recursive rm bypasses exported unlinkSync: the whole known tree is one burst.
  entries += sizes.size;
  bytes += [...sizes.values()].reduce((sum, size) => sum + size, 0);
  sizes.clear();
};
timers.setTimeout = async (ms, value, options) => {
  const start = performance.now();
  const result = await sleep(ms, value, options);
  batches.push({ entries, bytes, pauseMs: ms ?? 1, actualPauseMs: performance.now() - start });
  entries = 0;
  bytes = 0;
  return result;
};
syncBuiltinESMExports();
const argv = process.argv;
process.argv = [argv[0]!, argv[1]!, retired];
const cpu = process.cpuUsage();
const allocation = getHeapStatistics().total_allocated_bytes;
assert(Number.isFinite(allocation));
const loadBefore = os.loadavg();
const start = performance.now();
try {
  await import(
    values.worker
      ? pathToFileURL(path.resolve(values.worker)).href
      : "../../src/agents/worktrees/retired-worktree-cleanup.worker.js"
  );
} finally {
  process.argv = argv;
  fs.unlinkSync = unlink;
  fs.rmdirSync = rmdir;
  fs.rmSync = rm;
  timers.setTimeout = sleep;
  syncBuiltinESMExports();
}
const elapsedMs = performance.now() - start;
const used = process.cpuUsage(cpu);
const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocation;
batches.push({ entries, bytes, pauseMs: 0, actualPauseMs: 0 });
assert.equal(sizes.size, 0);
assert(!fs.existsSync(retired));
const report = {
  files,
  fileBytes,
  entryCount,
  elapsedMs,
  cpuMs: (used.user + used.system) / 1000,
  allocatedBytes,
  loadBefore,
  loadAfter: os.loadavg(),
  maxBatchEntries: Math.max(...batches.map((batch) => batch.entries)),
  maxBatchBytes: Math.max(...batches.map((batch) => batch.bytes)),
  pauses: batches.filter((batch) => batch.pauseMs > 0).length,
  batches,
};
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, batches: undefined }));
