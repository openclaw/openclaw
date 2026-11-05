import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadRatchetReference,
  loadRatchetSnapshot,
  loadRatchetSources,
  parseRatchetArgs,
  parseRatchetScalar,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

const BASELINE = "config/test-lines-baseline.txt";
const ALLOCATIONS = "config/test-lines-allocations";
const PATTERNS = [
  "*.test.ts",
  "*.test.tsx",
  "*.test.mts",
  "*.test.mjs",
  "*.test.js",
  "*.test.cjs",
  "*.test-support.ts",
  "*test-helpers*",
  "**/test-support/**",
];

function countNewlines(source: Buffer) {
  let lines = 0;
  for (let offset = source.indexOf(10); offset !== -1; offset = source.indexOf(10, offset + 1)) {
    lines += 1;
  }
  return lines;
}

function countFiles(root: string, files: string[], ref: string | null) {
  let total = 0;
  if (ref !== null) {
    // Bound index/reference snapshots instead of concatenating the entire test tree.
    for (let offset = 0; offset < files.length; offset += 32) {
      for (const source of loadRatchetSources(
        root,
        files.slice(offset, offset + 32),
        ref,
      ).values()) {
        total += countNewlines(Buffer.from(source));
      }
    }
    return total;
  }
  const buffer = Buffer.alloc(64 * 1024);
  for (const file of files) {
    // Unstaged deletions stay in ls-files; they count as zero lines.
    if (!fs.existsSync(path.join(root, file))) {
      continue;
    }
    const descriptor = fs.openSync(path.join(root, file), "r");
    try {
      let size;
      while ((size = fs.readSync(descriptor, buffer)) > 0) {
        total += countNewlines(buffer.subarray(0, size));
      }
    } finally {
      fs.closeSync(descriptor);
    }
  }
  return total;
}

function countTestLines(root: string, staged: boolean) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...PATTERNS], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  return countFiles(root, files, staged ? "" : null);
}

function countTestLineDelta(root: string, base: string, staged: boolean) {
  const entries = execFileSync(
    "git",
    [
      "diff",
      "--name-status",
      "--no-renames",
      "-z",
      ...(staged ? ["--cached"] : []),
      base,
      "--",
      ...PATTERNS,
    ],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  const before: string[] = [];
  const after: string[] = [];
  for (let index = 0; index < entries.length; index += 2) {
    const status = entries[index];
    const file = entries[index + 1]!;
    if (status !== "A") {
      before.push(file);
    }
    if (status !== "D") {
      after.push(file);
    }
  }
  // Git numstat counts unterminated lines; the ceiling counts literal LF bytes.
  // Read only changed sources so both measurements use the same unit.
  return countFiles(root, after, staged ? "" : null) - countFiles(root, before, base);
}

function parseCount(source: string, file: string) {
  const value = parseRatchetScalar(source, file);
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${file} must contain a safe integer`);
  }
  return value;
}

function loadAllocations(root: string, staged: boolean, ref?: string) {
  const files = execFileSync(
    "git",
    ref
      ? ["ls-tree", "-r", "--name-only", "-z", ref, "--", ALLOCATIONS]
      : ["ls-files", "-z", "--", ALLOCATIONS],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => file.endsWith(".txt"));
  const allocations = new Map<string, number>();
  if (ref || staged) {
    for (let offset = 0; offset < files.length; offset += 32) {
      for (const [file, source] of loadRatchetSources(
        root,
        files.slice(offset, offset + 32),
        ref ?? "",
      )) {
        allocations.set(file, parseCount(source, file));
      }
    }
    return allocations;
  }
  for (const file of files) {
    // Worktree deletions remove credit; untracked files never grant it.
    if (!fs.existsSync(path.join(root, file))) {
      continue;
    }
    allocations.set(file, parseCount(fs.readFileSync(path.join(root, file), "utf8"), file));
  }
  return allocations;
}

function effectiveCeiling(baseline: number, allocations: Map<string, number>) {
  const ceiling = baseline + [...allocations.values()].reduce((sum, value) => sum + value, 0);
  if (!Number.isSafeInteger(ceiling)) {
    throw new Error("Test line ceiling exceeds a safe integer");
  }
  return ceiling;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }
    const parse = (source: string) => parseCount(source, BASELINE);
    const baseline = loadRatchetSnapshot(root, BASELINE, args.staged, parse);
    const allocations = loadAllocations(root, args.staged);
    const ceiling = effectiveCeiling(baseline, allocations);
    const base = resolveRatchetBase(root, args);
    const previous = base ? loadRatchetReference(root, base, BASELINE, parse) : null;
    const previousAllocations = base
      ? loadAllocations(root, false, base)
      : new Map<string, number>();
    const previousCeiling =
      previous === null ? null : effectiveCeiling(previous, previousAllocations);
    const total = countTestLines(root, args.staged);
    const delta = base ? countTestLineDelta(root, base, args.staged) : null;
    if (
      allocations.size !== previousAllocations.size ||
      [...allocations].some(([file, value]) => previousAllocations.get(file) !== value)
    ) {
      if (previousCeiling === null || delta === null) {
        throw new Error("Test line allocation changes require a comparison base with a baseline");
      }
      // A prune folds allocations into the scalar. Compare effective ceilings
      // so an older branch cannot count that folded credit a second time.
      const credit = Math.max(0, ceiling - previousCeiling);
      if (credit > Math.max(0, delta)) {
        throw new Error(
          `Test line allocation credit ${credit} exceeds added test lines ${Math.max(0, delta)}.`,
        );
      }
    }
    if (
      previous !== null &&
      previousCeiling !== null &&
      baseline > previous &&
      ceiling > previousCeiling
    ) {
      console.warn(
        `Test line ceiling raised manually: ${previousCeiling} -> ${ceiling}; justify this in the PR.`,
      );
    }
    if (total > ceiling) {
      const details = `Test lines: ${total}; ceiling: ${ceiling}; over by: ${total - ceiling}; net delta: ${delta !== null && delta > 0 ? "+" : ""}${delta ?? "unavailable"}.`;
      if (!args.prune && delta !== null && delta <= 0) {
        console.log(`${details} Tree is over the ceiling; this change does not add test lines.`);
        return 0;
      }
      console.error(
        `${details}\nOffset the added lines by deleting or consolidating tests elsewhere, or add a justified allocation in ${ALLOCATIONS}/<change>.txt.`,
      );
      return 1;
    }
    if (args.prune && (total < ceiling || allocations.size > 0)) {
      fs.writeFileSync(path.join(root, BASELINE), `${total}\n`);
      for (const file of allocations.keys()) {
        fs.unlinkSync(path.join(root, file));
      }
      console.log(`Pruned ${BASELINE}: ${ceiling} -> ${total}.`);
    } else {
      console.log(`Test lines OK: ${total}; ceiling: ${ceiling}; slack: ${ceiling - total}.`);
    }
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
