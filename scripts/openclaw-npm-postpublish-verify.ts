#!/usr/bin/env -S node --import tsx

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { BUNDLED_RUNTIME_SIDECAR_PATHS } from "../src/plugins/runtime-sidecar-paths.ts";
import { parseReleaseVersion, resolveNpmCommandInvocation } from "./openclaw-npm-release-check.ts";

type InstalledPackageJson = {
  version?: string;
};

export type PublishedInstallScenario = {
  name: string;
  installSpecs: string[];
  expectedVersion: string;
};

export function buildPublishedInstallScenarios(version: string): PublishedInstallScenario[] {
  const parsed = parseReleaseVersion(version);
  if (parsed === null) {
    throw new Error(`Unsupported release version "${version}".`);
  }

  const exactSpec = `openclaw@${version}`;
  const scenarios: PublishedInstallScenario[] = [
    {
      name: "fresh-exact",
      installSpecs: [exactSpec],
      expectedVersion: version,
    },
  ];

  if (parsed.channel === "stable" && parsed.correctionNumber !== undefined) {
    scenarios.push({
      name: "upgrade-from-base-stable",
      installSpecs: [`openclaw@${parsed.baseVersion}`, exactSpec],
      expectedVersion: version,
    });
  }

  return scenarios;
}

export function collectInstalledPackageErrors(params: {
  expectedVersion: string;
  installedVersion: string;
  packageRoot: string;
}): string[] {
  const errors: string[] = [];

  if (params.installedVersion !== params.expectedVersion) {
    errors.push(
      `installed package version mismatch: expected ${params.expectedVersion}, found ${params.installedVersion || "<missing>"}.`,
    );
  }

  for (const relativePath of BUNDLED_RUNTIME_SIDECAR_PATHS) {
    if (!existsSync(join(params.packageRoot, relativePath))) {
      errors.push(`installed package is missing required bundled runtime sidecar: ${relativePath}`);
    }
  }

  return errors;
}

function npmExec(args: string[], cwd: string): string {
  const invocation = resolveNpmCommandInvocation({
    npmExecPath: process.env.npm_execpath,
    nodeExecPath: process.execPath,
    platform: process.platform,
  });

  return execFileSync(invocation.command, [...invocation.args, ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveGlobalRoot(prefixDir: string, cwd: string): string {
  return npmExec(["root", "-g", "--prefix", prefixDir], cwd);
}

function installSpec(prefixDir: string, spec: string, cwd: string): void {
  npmExec(["install", "-g", "--prefix", prefixDir, spec, "--no-fund", "--no-audit"], cwd);
}

function verifyScenario(version: string, scenario: PublishedInstallScenario): void {
  const workingDir = mkdtempSync(join(tmpdir(), `openclaw-postpublish-${scenario.name}.`));
  const prefixDir = join(workingDir, "prefix");

  try {
    for (const spec of scenario.installSpecs) {
      installSpec(prefixDir, spec, workingDir);
    }

    const globalRoot = resolveGlobalRoot(prefixDir, workingDir);
    const packageRoot = join(globalRoot, "openclaw");
    const pkg = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as InstalledPackageJson;
    const errors = collectInstalledPackageErrors({
      expectedVersion: scenario.expectedVersion,
      installedVersion: pkg.version?.trim() ?? "",
      packageRoot,
    });

    if (errors.length > 0) {
      throw new Error(`${scenario.name} failed:\n- ${errors.join("\n- ")}`);
    }

    console.log(`openclaw-npm-postpublish-verify: ${scenario.name} OK (${version})`);
  } finally {
    rmSync(workingDir, { force: true, recursive: true });
  }
}

function main(): void {
  const version = process.argv[2]?.trim();
  if (!version) {
    throw new Error(
      "Usage: node --import tsx scripts/openclaw-npm-postpublish-verify.ts <version>",
    );
  }

  const scenarios = buildPublishedInstallScenarios(version);
  for (const scenario of scenarios) {
    verifyScenario(version, scenario);
  }

  console.log(
    `openclaw-npm-postpublish-verify: verified published npm install paths for ${version}.`,
  );
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (entrypoint !== null && import.meta.url === entrypoint) {
  try {
    main();
  } catch (error) {
    console.error(
      `openclaw-npm-postpublish-verify: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
