#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const DOCS_GLOBS = ["docs/**/*.md", "docs/**/*.mdx", "README.md"];
const MAX_ARGS_LENGTH = 8000;

function fail(message) {
  console.error(`format:docs: ${message}`);
  process.exit(1);
}

function parseMode(args) {
  const check = args.includes("--check");
  const write = args.includes("--write");

  if (check === write) {
    fail("pass exactly one of --check or --write");
  }

  return check ? "--check" : "--write";
}

function runGitList() {
  const result = spawnSync("git", ["ls-files", "-z", ...DOCS_GLOBS], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }

  return result.stdout.split("\0").filter(Boolean);
}

function chunkFiles(files) {
  const chunks = [];
  let current = [];
  let length = 0;

  for (const file of files) {
    const nextLength = length + file.length + 1;
    if (current.length > 0 && nextLength > MAX_ARGS_LENGTH) {
      chunks.push(current);
      current = [];
      length = 0;
    }
    current.push(file);
    length += file.length + 1;
  }

  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks;
}

function runOxfmt(mode, files) {
  const chunks = chunkFiles(files);

  for (const chunk of chunks) {
    const result = spawnSync("oxfmt", [mode, ...chunk], {
      stdio: "inherit",
    });
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

const mode = parseMode(process.argv.slice(2));
const files = runGitList();

if (files.length === 0) {
  process.exit(0);
}

runOxfmt(mode, files);
