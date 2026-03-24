#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    shell: options.shell ?? false,
  });
}

function chunkArgs(items, maxCharacters = 7000) {
  const batches = [];
  let currentBatch = [];
  let currentLength = 0;

  for (const item of items) {
    const itemLength = item.length + 1;
    if (currentBatch.length > 0 && currentLength + itemLength > maxCharacters) {
      batches.push(currentBatch);
      currentBatch = [];
      currentLength = 0;
    }
    currentBatch.push(item);
    currentLength += itemLength;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function listDocFiles() {
  const result = run("git", ["ls-files", "docs/**/*.md", "docs/**/*.mdx", "README.md"]);
  if (result.status !== 0) {
    const details = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new Error(details || "git ls-files failed");
  }
  return (result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function main(argv = process.argv.slice(2)) {
  const mode = argv[0];
  if (mode !== "--write" && mode !== "--check") {
    process.stderr.write("Usage: node scripts/format-docs.mjs --write|--check\n");
    return 2;
  }

  const files = listDocFiles();
  if (files.length === 0) {
    return 0;
  }

  const oxfmtEntry = path.join(process.cwd(), "node_modules", "oxfmt", "bin", "oxfmt");

  for (const batch of chunkArgs(files)) {
    const result = run(process.execPath, [oxfmtEntry, mode, ...batch], { stdio: "inherit" });
    if ((result.status ?? 1) !== 0) {
      return result.status ?? 1;
    }
  }

  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exit(main());
  } catch (error) {
    process.stderr.write(`${String(error.message ?? error)}\n`);
    process.exit(1);
  }
}
