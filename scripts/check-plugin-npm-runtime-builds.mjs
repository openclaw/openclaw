#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  buildPluginNpmRuntime,
  resolvePluginNpmRuntimeBuildPlan,
} from "./lib/plugin-npm-runtime-build.mjs";

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function isPublishablePluginPackage(packageJson) {
  return packageJson.openclaw?.release?.publishToNpm === true;
}

function listPublishablePluginPackageDirs(repoRoot) {
  const extensionsRoot = path.join(repoRoot, "extensions");
  return fs
    .readdirSync(extensionsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join("extensions", entry.name))
    .filter((packageDir) => {
      const packageJsonPath = path.join(repoRoot, packageDir, "package.json");
      return (
        fs.existsSync(packageJsonPath) && isPublishablePluginPackage(readJsonFile(packageJsonPath))
      );
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function parseArgs(argv) {
  const packageDirs = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--package") {
      const packageDir = argv[index + 1];
      if (!packageDir) {
        throw new Error("missing value for --package");
      }
      packageDirs.push(packageDir);
      index += 1;
      continue;
    }
    throw new Error(
      "usage: node scripts/check-plugin-npm-runtime-builds.mjs [--package extensions/<id> ...]",
    );
  }
  return { packageDirs };
}

function listMissingRuntimeOutputs(plan) {
  return Object.keys(plan.entry)
    .map((entryKey) => path.join(plan.outDir, `${entryKey}.js`))
    .filter((filePath) => !fs.existsSync(filePath));
}

export async function checkPluginNpmRuntimeBuilds(params = {}) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDirs =
    params.packageDirs?.length > 0
      ? params.packageDirs
      : listPublishablePluginPackageDirs(repoRoot);
  const rows = [];
  for (const packageDir of packageDirs) {
    const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot, packageDir });
    if (!plan) {
      throw new Error(`${packageDir} did not produce a package-local runtime build plan`);
    }
    const result = await buildPluginNpmRuntime({
      repoRoot,
      packageDir,
      logLevel: params.logLevel ?? "warn",
    });
    const missing = listMissingRuntimeOutputs(result);
    if (missing.length > 0) {
      throw new Error(
        `${packageDir} missing built runtime outputs: ${missing
          .map((filePath) => path.relative(repoRoot, filePath))
          .join(", ")}`,
      );
    }
    rows.push({
      pluginDir: result.pluginDir,
      entryCount: Object.keys(result.entry).length,
      copiedStaticAssets: result.copiedStaticAssets,
    });
  }
  return rows;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const rows = await checkPluginNpmRuntimeBuilds(args);
    console.log(`built ${rows.length} publishable plugin runtimes`);
    for (const row of rows) {
      console.log(
        [
          row.pluginDir,
          row.entryCount,
          row.copiedStaticAssets.length > 0 ? row.copiedStaticAssets.join(",") : "-",
        ].join("\t"),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
