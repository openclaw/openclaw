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

function countTestLines(root: string, staged: boolean) {
  const files = execFileSync("git", ["ls-files", "-z", "--", ...PATTERNS], {
    cwd: root,
    maxBuffer: 256 * 1024 * 1024,
  })
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  let total = 0;
  if (staged) {
    // Bound index snapshots instead of concatenating the entire test tree.
    for (let offset = 0; offset < files.length; offset += 32) {
      for (const source of loadRatchetSources(root, files.slice(offset, offset + 32)).values()) {
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
    ["diff", "--numstat", "-z", ...(staged ? ["--cached"] : []), base, "--", ...PATTERNS],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
  let delta = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const [added, removed] = entry.split("\t", 2);
    if (added !== "-") {
      delta += Number(added) - Number(removed);
    }
    // NUL-delimited rename records carry the old and new paths separately.
    if (entry === `${added}\t${removed}\t`) {
      index += 2;
    }
  }
  return delta;
}

export function main(root = process.cwd(), argv = process.argv.slice(2)) {
  try {
    const args = parseRatchetArgs(argv);
    if (args.staged && args.prune) {
      throw new Error("--prune cannot be combined with --staged");
    }
    const parse = (source: string) => {
      const value = parseRatchetScalar(source, BASELINE);
      if (!Number.isSafeInteger(value)) {
        throw new Error(`${BASELINE} must contain a safe integer`);
      }
      return value;
    };
    const ceiling = loadRatchetSnapshot(root, BASELINE, args.staged, parse);
    const base = resolveRatchetBase(root, args);
    const previous = base ? loadRatchetReference(root, base, BASELINE, parse) : null;
    if (previous !== null && ceiling > previous) {
      console.warn(
        `Test line ceiling raised manually: ${previous} -> ${ceiling}; justify this in the PR.`,
      );
    }
    const total = countTestLines(root, args.staged);
    const delta = base ? countTestLineDelta(root, base, args.staged) : null;
    if (total > ceiling) {
      const details = `Test lines: ${total}; ceiling: ${ceiling}; over by: ${total - ceiling}; net delta: ${delta !== null && delta > 0 ? "+" : ""}${delta ?? "unavailable"}.`;
      if (!args.prune && delta !== null && delta <= 0) {
        console.log(`${details} Tree is over the ceiling; this change does not add test lines.`);
        return 0;
      }
      console.error(
        `${details}\nOffset the added lines by deleting or consolidating tests elsewhere, or raise the ceiling in ${BASELINE} with justification in the PR.`,
      );
      return 1;
    }
    if (args.prune && total < ceiling) {
      fs.writeFileSync(path.join(root, BASELINE), `${total}\n`);
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
