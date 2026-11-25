#!/usr/bin/env node
// Checks built package dist files for imports outside package boundaries.
import fs from "node:fs";
import path from "node:path";
import { collectPackageDistImportErrors } from "./lib/package-dist-imports.mjs";

function usage() {
  return "Usage: node scripts/check-package-dist-imports.mjs [package-root] [--imports <composition-imports.json>]";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const packageRootArg = args[0]?.trim() ?? "";
  if (packageRootArg === "--help" || packageRootArg === "-h") {
    return { help: true, packageRoot: "" };
  }
  if (packageRootArg.startsWith("-")) {
    throw new Error(`Unknown package dist import check option: ${packageRootArg}`);
  }
  const extraArg = args[1]?.trim();
  const importsFile = extraArg === "--imports" ? args[2]?.trim() : undefined;
  if (args.length > 1 && (args.length !== 3 || !importsFile)) {
    throw new Error(`Unexpected package dist import check argument: ${extraArg}`);
  }
  return {
    help: false,
    packageRoot: path.resolve(packageRootArg || process.cwd()),
    importsFile: importsFile ? path.resolve(importsFile) : undefined,
  };
}

let cliArgs;
try {
  cliArgs = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (cliArgs.help) {
  console.log(usage());
  process.exit(0);
}

const { packageRoot } = cliArgs;
const distRoot = path.join(packageRoot, "dist");
if (!fs.existsSync(distRoot)) {
  fail(`missing dist directory: ${distRoot}`);
}

function collectFiles(rootDir) {
  const pending = [rootDir];
  const files = [];
  while (pending.length > 0) {
    const dir = pending.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(path.relative(packageRoot, entryPath).replace(/\\/gu, "/"));
      }
    }
  }
  return files;
}

const files = collectFiles(distRoot);
const fileSet = new Set(files);
// The composition archive owns these edges; lifecycle and pruning may remove
// importers, but any retained importer must still have its runtime targets.
const imports = cliArgs.importsFile
  ? JSON.parse(fs.readFileSync(cliArgs.importsFile, "utf8")).filter((edge) =>
      fileSet.has(edge.importerPath),
    )
  : undefined;
const errors = collectPackageDistImportErrors({
  files,
  imports,
  readText(relativePath) {
    return fs.readFileSync(path.join(packageRoot, relativePath), "utf8");
  },
});

if (errors.length > 0) {
  fail(`OpenClaw package dist import closure failed:\n${errors.join("\n")}`);
}

console.log("OpenClaw package dist import closure passed.");
