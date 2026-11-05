// Run on a disposable btrfs mount with filefrag installed:
// node --import ./scripts/tsx.mjs scripts/perf/sqlite-snapshot-retirement.mts --root /mnt/proof
// Defaults: sparse 35 GiB, 573,440 written ranges, two A/A controls and five A/B pairs.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { removeTempDirectoryAsync } from "../../src/infra/sqlite-readonly-location-cleanup.js";

const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const parent = args.includes("--root") ? option("--root") : undefined;
if (!parent) {
  throw new Error("Pass --root with an existing disposable filesystem directory");
}
const gib = args.includes("--gib") ? Number(option("--gib")) : 35;
const pairs = args.includes("--pairs") ? Number(option("--pairs")) : 5;
if (!(gib > 0) || !Number.isInteger(pairs) || pairs < 1) {
  throw new Error("--gib must be positive and --pairs must be a positive integer");
}
const root = fs.mkdtempSync(path.join(path.resolve(parent), "snapshot-retirement-bench-"));
const source = path.join(root, "source");
const bytes = Math.floor(gib * 1024 ** 3);
const records = [];
try {
  const fd = fs.openSync(source, "wx");
  try {
    fs.ftruncateSync(fd, bytes);
    const block = Buffer.alloc(4096, 0x6d);
    for (let offset = 0; offset < bytes; offset += 65536) {
      fs.writeSync(fd, block, 0, Math.min(block.length, bytes - offset), offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const fixture = fs.statSync(source);
  const filefrag =
    process.platform === "linux"
      ? execFileSync("filefrag", ["-v", source], { encoding: "utf8", maxBuffer: 128 * 1024 ** 2 })
      : undefined;
  const labels = [
    "aa1",
    "aa2",
    ...Array.from({ length: pairs }, (_, i) => [`a${i + 1}`, `b${i + 1}`]).flat(),
  ];
  for (const label of labels) {
    const directory = fs.mkdtempSync(path.join(root, `${label}-`));
    const payload = path.join(directory, "database.sqlite");
    const cloneAt = performance.now();
    fs.copyFileSync(source, payload, fs.constants.COPYFILE_FICLONE_FORCE);
    const cloneMs = performance.now() - cloneAt;
    const originalTruncate = fs.ftruncateSync;
    const originalTruncateAsync = fs.ftruncate;
    const originalRm = fs.promises.rm;
    const truncates: number[] = [];
    let synchronousTruncates = 0;
    let finalRemovalBytes = bytes;
    let finalRemovalMs = 0;
    fs.ftruncateSync = (...callArgs) => {
      const at = performance.now();
      originalTruncate(...callArgs);
      synchronousTruncates++;
      truncates.push(performance.now() - at);
    };
    fs.ftruncate = Object.assign(
      (
        descriptor: number,
        length: number | fs.NoParamCallback | undefined,
        callback?: fs.NoParamCallback,
      ) => {
        const at = performance.now();
        const complete: fs.NoParamCallback = (error) => {
          // Callback elapsed time includes scheduling, not later btrfs commit work.
          truncates.push(performance.now() - at);
          if (typeof length === "function") {
            length(error);
          } else {
            callback?.(error);
          }
        };
        if (typeof length === "function") {
          originalTruncateAsync(descriptor, complete);
        } else {
          originalTruncateAsync(descriptor, length, complete);
        }
      },
      originalTruncateAsync,
    );
    fs.promises.rm = async (...callArgs) => {
      finalRemovalBytes = fs.statSync(payload).size;
      const at = performance.now();
      await originalRm(...callArgs);
      finalRemovalMs = performance.now() - at;
    };
    const cpuBefore = process.cpuUsage();
    const at = performance.now();
    try {
      if (label.startsWith("b")) {
        if (!(await removeTempDirectoryAsync(directory))) {
          throw new Error("Snapshot cleanup failed");
        }
      } else {
        const unlinkAt = performance.now();
        fs.unlinkSync(payload);
        finalRemovalMs = performance.now() - unlinkAt;
        fs.rmdirSync(directory);
      }
    } finally {
      fs.ftruncateSync = originalTruncate;
      fs.ftruncate = originalTruncateAsync;
      fs.promises.rm = originalRm;
    }
    const durationMs = performance.now() - at;
    const cpu = process.cpuUsage(cpuBefore);
    records.push({
      label,
      cloneMs,
      durationMs,
      cpuMs: (cpu.user + cpu.system) / 1000,
      truncates: truncates.length,
      synchronousTruncates,
      maxTruncateMs: Math.max(0, ...truncates),
      finalRemovalBytes,
      finalRemovalMs,
    });
  }
  console.log(
    JSON.stringify(
      {
        fixture: {
          bytes,
          allocatedBytes: fixture.blocks * 512,
          writtenRanges: Math.ceil(bytes / 65536),
          fiemapEntries: filefrag?.split("\n").filter((line) => /^\s*\d+:/u.test(line)).length,
        },
        platform: process.platform,
        node: process.version,
        truncateTiming: "Call-to-completion; excludes deferred filesystem transaction work",
        records,
      },
      null,
      2,
    ),
  );
} finally {
  if (!(await removeTempDirectoryAsync(root))) {
    console.error(`Benchmark cleanup failed: ${root}`);
    process.exitCode = 1;
  }
}
