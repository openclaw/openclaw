#!/usr/bin/env -S node --import tsx

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPathGroups = [
  ["dist/index.js", "dist/index.mjs"],
  ["dist/entry.js", "dist/entry.mjs"],
  "dist/plugin-sdk/index.js",
  "dist/plugin-sdk/index.d.ts",
  "dist/build-info.json",
];
const forbiddenPrefixes = ["dist/OpenClaw.app/"];

type PackageJson = {
  name?: string;
  version?: string;
};

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json --ignore-scripts", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 1024 * 1024 * 100,
  });
  return JSON.parse(raw) as PackResult[];
}

function checkPluginVersions() {
  const rootPackagePath = resolve("package.json");
  const rootPackage = JSON.parse(readFileSync(rootPackagePath, "utf8")) as PackageJson;
  const targetVersion = rootPackage.version;

  if (!targetVersion) {
    process.stderr.write("release-check: root package.json missing version.\n");
    process.exit(1);
  }

  const extensionsDir = resolve("extensions");
  const entries = readdirSync(extensionsDir, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory(),
  );

  const mismatches: string[] = [];

  for (const entry of entries) {
    const packagePath = join(extensionsDir, entry.name, "package.json");
    let pkg: PackageJson;
    try {
      pkg = JSON.parse(readFileSync(packagePath, "utf8")) as PackageJson;
    } catch {
      continue;
    }

    if (!pkg.name || !pkg.version) {
      continue;
    }

    if (pkg.version !== targetVersion) {
      mismatches.push(`${pkg.name} (${pkg.version})`);
    }
  }

  if (mismatches.length > 0) {
    process.stderr.write(`release-check: plugin versions must match ${targetVersion}:\n`);
    for (const item of mismatches) {
      process.stderr.write(`  - ${item}\n`);
    }
    process.stderr.write("release-check: run `pnpm plugins:sync` to align plugin versions.\n");
    process.exit(1);
  }
}

function main() {
  checkPluginVersions();

  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPathGroups
    .flatMap((group) => {
      if (Array.isArray(group)) {
        return group.some((path) => paths.has(path)) ? [] : [group.join(" or ")];
      }
      return paths.has(group) ? [] : [group];
    })
    .toSorted();
  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      process.stderr.write("release-check: missing files in npm pack:\n");
      for (const path of missing) {
        process.stderr.write(`  - ${path}\n`);
      }
    }
    if (forbidden.length > 0) {
      process.stderr.write("release-check: forbidden files in npm pack:\n");
      for (const path of forbidden) {
        process.stderr.write(`  - ${path}\n`);
      }
    }
    process.exit(1);
  }

  process.stdout.write("release-check: npm pack contents look OK.\n");
}

main();
