#!/usr/bin/env -S node --import tsx

// Packs plugins with this checkout's toolchain and scans the exact tarballs.
// Release publication repacks with its own trusted tooling, so a bundler,
// lockfile, or plugin change that drifts a reviewed finding must fail here, in
// the change that causes it, instead of at publish time. CI selects packages
// with selectPluginNpmSecurityScanPackageDirs.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runTasksWithConcurrency } from "../src/utils/run-with-concurrency.js";
import { hasUnjoinedWork, runManagedCommand } from "./lib/managed-child-process.mts";
import { scanPluginNpmArtifactSecurity } from "./plugin-npm-security-scan.mts";

// Same per-command ceiling as the pretag pack check: a complete build and pack
// keeps its normal budget while lifecycle or registry stalls stop.
const PACK_TIMEOUT_MS = 10 * 60_000;
// Packs are package-local; four overlap the build, install, and registry waits.
const PACK_CONCURRENCY = 4;

async function packAndScan(rootDir: string, outputRoot: string, packageDir: string) {
  const outputDir = mkdtempSync(join(outputRoot, "pack-"));
  const status = await runManagedCommand({
    args: ["scripts/plugin-npm-publish.sh", "--pack", packageDir],
    bin: "bash",
    cwd: rootDir,
    env: { ...process.env, OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR: outputDir },
    shell: false,
    requireProcessTreeExit: process.platform !== "win32",
    stdio: ["ignore", "ignore", "inherit"],
    timeoutMs: PACK_TIMEOUT_MS,
  });
  if (status !== 0) {
    throw new Error(`npm pack failed with exit code ${status}`);
  }
  const [tarball, ...extra] = readdirSync(outputDir).filter((name) => name.endsWith(".tgz"));
  if (!tarball || extra.length > 0) {
    throw new Error(`expected one packed tarball, found ${extra.length + (tarball ? 1 : 0)}`);
  }
  const packageJson = JSON.parse(readFileSync(join(rootDir, packageDir, "package.json"), "utf8"));
  const report = scanPluginNpmArtifactSecurity({
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    tarball: readFileSync(join(outputDir, tarball)),
  });
  rmSync(outputDir, { recursive: true, force: true });
  return report;
}

async function runPluginNpmSecurityScanCheck(packageDirs: readonly string[]) {
  const rootDir = resolve(".");
  const outputRoot = mkdtempSync(join(tmpdir(), "openclaw-plugin-npm-security-scan-"));
  const failures: string[] = [];
  let unjoinedWork = false;
  try {
    await runTasksWithConcurrency({
      limit: PACK_CONCURRENCY,
      tasks: packageDirs.map((packageDir) => async () => {
        try {
          const report = await packAndScan(rootDir, outputRoot, packageDir);
          console.log(
            `plugin npm security scan: ${report.packageName} ok (${report.criticalFindingCount} reviewed critical findings)`,
          );
        } catch (error) {
          unjoinedWork ||= hasUnjoinedWork(error);
          failures.push(`${packageDir}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    });
  } finally {
    if (!unjoinedWork) {
      rmSync(outputRoot, { recursive: true, force: true });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      [
        `plugin npm security scan failed for ${failures.length} of ${packageDirs.length} packages:`,
        ...failures.toSorted(),
        "A reviewed finding drifted or a new critical finding appeared. Review the packed bytes, then update the inventory in scripts/plugin-npm-security-scan.mts.",
      ].join("\n"),
    );
  }
  console.log(`plugin npm security scan: ${packageDirs.length} packages passed.`);
}

function parsePackageDirs(argv: readonly string[]) {
  const packageDirs: string[] = [];
  for (let index = 0; index < argv.length; index += 2) {
    const value = argv[index + 1];
    if (argv[index] !== "--package" || !value || value.startsWith("-")) {
      break;
    }
    packageDirs.push(value);
  }
  if (packageDirs.length === 0 || packageDirs.length * 2 !== argv.length) {
    throw new Error(
      "usage: node --import tsx scripts/check-plugin-npm-security-scan.mts --package extensions/<id> [--package ...]",
    );
  }
  return packageDirs;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    await runPluginNpmSecurityScanCheck(parsePackageDirs(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
