import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { releaseBranchForChecks } from "./lib/check-limits.mts";
import {
  loadRatchetSources,
  parseRatchetArgs,
  parseRatchetScalar,
  resolveRatchetBase,
} from "./lib/shrink-ratchet.mts";

// Covers the regression tests a fix needs; larger growth needs a reviewed record.
const ALLOWANCE = 400;
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
  // Count literal LF bytes, like wc -l; git numstat also counts unterminated lines.
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

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.prune) {
      throw new Error("The test-line budget has no baseline to prune.");
    }
    if (releaseBranchForChecks(root)) {
      console.log("Test-line budget skipped for release branch.");
      return 0;
    }
    const base = resolveRatchetBase(root, args);
    if (!base) {
      throw new Error("The test-line budget needs a comparison base; pass --base <ref>.");
    }
    const delta = countTestLineDelta(root, base, args.staged);
    // Only records this change adds or raises cover its growth; merged records stay inert.
    const previous = loadAllocations(root, false, base);
    let credit = 0;
    for (const [file, value] of loadAllocations(root, args.staged)) {
      credit += Math.max(0, value - (previous.get(file) ?? 0));
    }
    const details = `Net test lines: ${delta > 0 ? "+" : ""}${delta}; allowance: ${ALLOWANCE}; allocation credit: ${credit}.`;
    if (delta > ALLOWANCE + credit) {
      console.error(
        `${details}\nDelete or consolidate tests to remove ${delta - ALLOWANCE - credit} lines, or add a justified ${ALLOCATIONS}/<change>.txt record of ${delta - ALLOWANCE} and state the reason in the PR.`,
      );
      return 1;
    }
    console.log(`Test lines OK. ${details}`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
