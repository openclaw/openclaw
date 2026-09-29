#!/usr/bin/env node

// Audits patched dependency pins for exact versions and drift.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import YAML from "yaml";
import { classifyDependencySpec } from "./lib/dependency-spec-policy.mts";

const PACKAGE_DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies"];
const DEFAULT_GIT_TIMEOUT_MS = 60_000;

type DependencyPinViolation = {
  file: string;
  section: string;
  name: string;
  spec: unknown;
};

function runGit(cwd: string, args: string[], timeoutMs = DEFAULT_GIT_TIMEOUT_MS): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      // A synchronous child that ignores SIGTERM otherwise keeps its parent blocked.
      killSignal: "SIGKILL",
    });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ETIMEDOUT") {
      throw new Error(
        `dependency pin guard: git ${args.join(" ")} timed out after ${timeoutMs}ms.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function listTrackedPackageJsonFiles(cwd: string, timeoutMs = DEFAULT_GIT_TIMEOUT_MS): string[] {
  return runGit(cwd, ["ls-files", "-z", "--", "*package.json"], timeoutMs)
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readJson(filePath: string): Record<string, unknown> {
  return asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown);
}

function readTrackedJson(
  cwd: string,
  relativePath: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Record<string, unknown> {
  const filePath = path.join(cwd, relativePath);
  if (fs.existsSync(filePath)) {
    return readJson(filePath);
  }
  return asRecord(JSON.parse(runGit(cwd, ["show", `:${relativePath}`], timeoutMs)) as unknown);
}

function collectPackageJsonAudit(cwd: string, timeoutMs = DEFAULT_GIT_TIMEOUT_MS) {
  const packageJsonFiles = listTrackedPackageJsonFiles(cwd, timeoutMs);
  let packageSpecCount = 0;
  const violations: DependencyPinViolation[] = [];
  for (const relativePath of packageJsonFiles) {
    const packageJson = readTrackedJson(cwd, relativePath, timeoutMs);
    for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
      for (const [name, spec] of Object.entries(asRecord(packageJson[section]))) {
        packageSpecCount += 1;
        if (!classifyDependencySpec(spec).allowedPinned) {
          violations.push({ file: relativePath, section, name, spec });
        }
      }
    }
  }
  return { packageManifestCount: packageJsonFiles.length, packageSpecCount, violations };
}

function collectDependencyMapViolations(
  file: string,
  section: string,
  dependencyMap: unknown,
  violations: DependencyPinViolation[],
): void {
  for (const [name, spec] of Object.entries(asRecord(dependencyMap))) {
    if (section === "overrides" && spec === "-") {
      continue;
    }
    if (!classifyDependencySpec(spec).allowedPinned) {
      violations.push({ file, section, name, spec });
    }
  }
}

function collectWorkspaceViolations(cwd: string): DependencyPinViolation[] {
  const file = "pnpm-workspace.yaml";
  const workspacePath = path.join(cwd, file);
  if (!fs.existsSync(workspacePath)) {
    return [];
  }
  const workspace = asRecord(YAML.parse(fs.readFileSync(workspacePath, "utf8")) as unknown);
  const violations: DependencyPinViolation[] = [];
  collectDependencyMapViolations(file, "overrides", workspace.overrides, violations);
  for (const [packageName, extension] of Object.entries(asRecord(workspace.packageExtensions))) {
    collectDependencyMapViolations(
      file,
      `packageExtensions.${packageName}.dependencies`,
      asRecord(extension).dependencies,
      violations,
    );
  }
  return violations;
}

export function collectDependencyPinViolations(
  cwd = process.cwd(),
  { gitTimeoutMs = DEFAULT_GIT_TIMEOUT_MS } = {},
): DependencyPinViolation[] {
  return [
    ...collectPackageJsonAudit(cwd, gitTimeoutMs).violations,
    ...collectWorkspaceViolations(cwd),
  ];
}

export async function main() {
  const audit = collectPackageJsonAudit(process.cwd());
  const violations = [...audit.violations, ...collectWorkspaceViolations(process.cwd())];
  if (violations.length === 0) {
    process.stdout.write(
      `PASS direct dependency pin guard: checked ${audit.packageSpecCount} directly declared ` +
        `dependency specs across ${audit.packageManifestCount} tracked package manifests; ` +
        "0 violations.\n",
    );
    return;
  }

  console.error(
    `FAIL direct dependency pin guard: ${violations.length} unpinned directly declared ` +
      "dependency specs found. Direct dependency specs must be pinned exactly outside peer " +
      "dependency contracts:",
  );
  for (const violation of violations) {
    console.error(
      `- ${violation.file}:${violation.section}:${violation.name} -> ${JSON.stringify(violation.spec)}`,
    );
  }
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
