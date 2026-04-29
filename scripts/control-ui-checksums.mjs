#!/usr/bin/env node
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const DEFAULT_INPUT_DIR = path.join(repoRoot, "dist", "control-ui");
const DEFAULT_OUTPUT_DIR = path.join(repoRoot, ".artifacts", "control-ui");

function usage() {
  process.stderr.write(
    "Usage: node scripts/control-ui-checksums.mjs [--input <dir>] [--output-dir <dir>]\n",
  );
}

function readOptionValue(args, index, name) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    inputDir: DEFAULT_INPUT_DIR,
    outputDir: DEFAULT_OUTPUT_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--input") {
      options.inputDir = path.resolve(readOptionValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--output-dir") {
      options.outputDir = path.resolve(readOptionValue(argv, i, arg));
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

async function collectFiles(dir, baseDir = dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const absolutePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolutePath, baseDir)));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    files.push({
      absolutePath,
      relativePath: path.relative(baseDir, absolutePath).replaceAll(path.sep, "/"),
    });
  }
  return files.toSorted((a, b) => a.relativePath.localeCompare(b.relativePath));
}

async function sha256File(filePath) {
  const data = await fs.readFile(filePath);
  return createHash("sha256").update(data).digest("hex");
}

export async function writeControlUiChecksums(options = {}) {
  const inputDir = path.resolve(options.inputDir ?? DEFAULT_INPUT_DIR);
  const outputDir = path.resolve(options.outputDir ?? DEFAULT_OUTPUT_DIR);
  const indexPath = path.join(inputDir, "index.html");
  try {
    await fs.access(indexPath);
  } catch {
    throw new Error(`Missing Control UI build at ${indexPath}. Run pnpm ui:build first.`);
  }

  const files = await collectFiles(inputDir);
  if (files.length === 0) {
    throw new Error(`Control UI build has no files: ${inputDir}`);
  }

  const entries = [];
  for (const file of files) {
    const stat = await fs.stat(file.absolutePath);
    entries.push({
      path: file.relativePath,
      bytes: stat.size,
      sha256: await sha256File(file.absolutePath),
    });
  }

  const generatedAt = process.env.SOURCE_DATE_EPOCH
    ? new Date(Number(process.env.SOURCE_DATE_EPOCH) * 1000).toISOString()
    : new Date().toISOString();
  const manifest = {
    generatedAt,
    source: "dist/control-ui",
    fileCount: entries.length,
    files: entries,
  };

  await fs.mkdir(outputDir, { recursive: true });
  const sumsPath = path.join(outputDir, "control-ui-sha256sums.txt");
  const manifestPath = path.join(outputDir, "control-ui-checksums.json");
  const sums = entries.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n") + "\n";
  await fs.writeFile(sumsPath, sums, "utf8");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return { sumsPath, manifestPath, entries };
}

async function main() {
  try {
    const result = await writeControlUiChecksums(parseArgs());
    process.stdout.write(
      `Wrote ${result.entries.length} Control UI checksums to ${path.relative(repoRoot, result.sumsPath)}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
