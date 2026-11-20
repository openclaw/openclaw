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
import { execFileSync } from "node:child_process";
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
    "reservation-counter": { type: "string" },
    reflink: { type: "boolean", default: false },
    "fake-reservations": { type: "boolean", default: false },
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
  const directory = path.join(retired, "node_modules", `package-${Math.floor(index / 100)}`, "lib");
  if (index % 100 === 0) {
    fs.mkdirSync(directory, { recursive: true });
    sizes.set(directory, 0);
    sizes.set(path.dirname(directory), 0);
    sizes.set(path.dirname(path.dirname(directory)), 0);
  }
  const file = path.join(directory, String(index));
  fs.writeFileSync(file, content);
  sizes.set(file, fileBytes);
}
// A sibling reflink checkout keeps shared extents live during retirement.
if (values.reflink) {
  execFileSync("cp", ["-a", "--reflink=always", retired, path.join(output, "sibling")]);
  execFileSync("sync", ["-f", retired]);
}
const entryCount = sizes.size;
let peakReservationBytes = 0;
let simulatedMs = 0;
let simulatedReservation = 0;
if (values["fake-reservations"]) {
  assert(
    values["reservation-counter"],
    "Bind a writable fake counter over this filesystem's sysfs counter",
  );
  fs.writeFileSync(values["reservation-counter"], "0\n");
}
const sampleReservation = () => {
  if (values["reservation-counter"]) {
    peakReservationBytes = Math.max(
      peakReservationBytes,
      Number(fs.readFileSync(values["reservation-counter"], "utf8")),
    );
  }
};
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
  if (values["fake-reservations"]) {
    // Deliberately synthetic: 3 MiB reserved per entry, drained every 30s.
    // This exercises feedback; it is not a calibrated btrfs cost model.
    simulatedReservation += 3 * 1024 ** 2;
    fs.writeFileSync(values["reservation-counter"]!, String(simulatedReservation));
  }
  if (entries % 128 === 0) {
    sampleReservation();
  }
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
  const result = await sleep(values["fake-reservations"] ? 0 : ms, value, options);
  if (values["fake-reservations"]) {
    const previousCommit = Math.floor(simulatedMs / 30_000);
    simulatedMs += ms ?? 1;
    if (Math.floor(simulatedMs / 30_000) > previousCommit) {
      simulatedReservation = 0;
      fs.writeFileSync(values["reservation-counter"]!, "0\n");
    }
  }
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
sampleReservation();
const sampler = setInterval(sampleReservation, 20);
try {
  await import(
    values.worker
      ? pathToFileURL(path.resolve(values.worker)).href
      : "../../src/agents/worktrees/retired-worktree-cleanup.worker.js"
  );
} finally {
  clearInterval(sampler);
  sampleReservation();
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
  peakReservationBytes,
  simulatedMs: values["fake-reservations"] ? simulatedMs : undefined,
  loadBefore,
  loadAfter: os.loadavg(),
  maxBatchEntries: Math.max(...batches.map((batch) => batch.entries)),
  maxBatchBytes: Math.max(...batches.map((batch) => batch.bytes)),
  pauses: batches.filter((batch) => batch.pauseMs > 0).length,
  batches,
};
fs.writeFileSync(path.join(output, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, batches: undefined }));
