#!/usr/bin/env -S node --import tsx
// Changed ClawHub plugin validation runs a pinned ClawHub CLI for PR-touched packages.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  collectClawHubPublishablePluginPackages,
  resolveChangedClawHubPublishablePluginPackages,
  type PublishablePluginPackage,
} from "./lib/plugin-clawhub-release.ts";
import { resolveGitCommitSha, type GitRangeSelection } from "./lib/plugin-npm-release.ts";

export const CLAWHUB_VALIDATE_CLI_PACKAGE = "clawhub@0.21.0";

type ChangedClawHubPackageValidatePlanItem = Pick<
  PublishablePluginPackage,
  "extensionId" | "packageDir" | "packageName"
>;

type ChangedClawHubPackageValidatePlanParams = {
  plugins: PublishablePluginPackage[];
  changedPaths: readonly string[];
};

type ParsedValidationResult = {
  warningCount: number;
  errorCount: number;
  blockingWarningKeys: string[];
};

type ValidateArgs = {
  baseRef?: string;
  headRef?: string;
};

export function createChangedClawHubPackageValidatePlan(
  params: ChangedClawHubPackageValidatePlanParams,
): ChangedClawHubPackageValidatePlanItem[] {
  return resolveChangedClawHubPublishablePluginPackages({
    plugins: params.plugins,
    changedPaths: params.changedPaths.filter(isClawHubPluginValidationRelevantPath),
  }).map((plugin) => ({
    extensionId: plugin.extensionId,
    packageDir: plugin.packageDir,
    packageName: plugin.packageName,
  }));
}

export function collectClawHubPluginValidationPathsFromGitRange(params: {
  rootDir?: string;
  gitRange: GitRangeSelection;
}): string[] {
  const rootDir = resolve(params.rootDir ?? ".");
  const { baseRef, headRef } = params.gitRange;
  const baseSha = resolveGitCommitSha(rootDir, baseRef, "baseRef");
  const headSha = resolveGitCommitSha(rootDir, headRef, "headRef");

  return execFileSync(
    "git",
    ["diff", "--name-only", "--diff-filter=ACDMR", baseSha, headSha, "--", "extensions"],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter(Boolean);
}

export function collectBaselineClawHubPublishablePluginPackages(params: {
  rootDir?: string;
  baselineRef: string;
}): ChangedClawHubPackageValidatePlanItem[] {
  const rootDir = resolve(params.rootDir ?? ".");
  const baselineSha = resolveGitCommitSha(rootDir, params.baselineRef, "baselineRef");
  const paths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", baselineSha, "--", "extensions"],
    {
      cwd: rootDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  )
    .split("\n")
    .map((line) => line.trim().replaceAll("\\", "/"))
    .filter((path) => /^extensions\/[^/]+\/package\.json$/u.test(path));

  return paths
    .flatMap((packagePath) =>
      readBaselineClawHubPublishablePackage({
        rootDir,
        baselineSha,
        packagePath,
      }),
    )
    .toSorted((left, right) => left.packageName.localeCompare(right.packageName));
}

export function assertNoRemovedClawHubPublishablePackages(params: {
  currentPlan: readonly ChangedClawHubPackageValidatePlanItem[];
  baselinePlugins: readonly ChangedClawHubPackageValidatePlanItem[];
  changedPaths: readonly string[];
}) {
  const changedExtensionIds = collectChangedExtensionIdsForClawHubValidation(params.changedPaths);
  if (changedExtensionIds.size === 0) {
    return;
  }

  const currentExtensionIds = new Set(params.currentPlan.map((plugin) => plugin.extensionId));
  const removedPlugins = params.baselinePlugins.filter(
    (plugin) =>
      changedExtensionIds.has(plugin.extensionId) && !currentExtensionIds.has(plugin.extensionId),
  );
  if (removedPlugins.length === 0) {
    return;
  }

  throw new Error(
    `Changed ClawHub-publishable plugin package metadata must remain visible to validation:\n${removedPlugins
      .map(
        (plugin) =>
          `- ${plugin.packageDir}: was ClawHub-publishable at ${plugin.packageName} in the base ref but is no longer publishable in the current head.`,
      )
      .join("\n")}`,
  );
}

export function buildClawHubPackageValidateCommand(
  packageDir: string,
  reportDir: string,
  repositoryRoot = ".",
) {
  const resolvedRepositoryRoot = resolve(repositoryRoot);
  return {
    command: "pnpm",
    args: [
      "dlx",
      "--config.minimum-release-age=0",
      CLAWHUB_VALIDATE_CLI_PACKAGE,
      "--workdir",
      resolvedRepositoryRoot,
      "package",
      "validate",
      packageDir,
      "--json",
      "--openclaw",
      resolvedRepositoryRoot,
      "--out",
      reportDir,
    ],
  };
}

export function parseClawHubValidationOutput(
  output: string,
  packageDir: string,
): Pick<ParsedValidationResult, "warningCount" | "errorCount"> {
  const result = parseClawHubValidationReport(output, packageDir);
  if (result.warningCount > 0 || result.errorCount > 0) {
    throw new Error(
      `${packageDir}: ClawHub validation reported ${formatCount(result.warningCount, "warning")} and ${formatCount(result.errorCount, "error")}.`,
    );
  }

  return {
    warningCount: result.warningCount,
    errorCount: result.errorCount,
  };
}

export function parseClawHubValidationReport(
  output: string,
  packageDir: string,
): ParsedValidationResult {
  const parsed = parseJsonObject(output, packageDir);
  const rawWarningCount =
    readNumericCount(parsed, "warningCount") ??
    readNestedNumericCount(parsed, "summary", "warningCount") ??
    readArrayCount(parsed, "warnings") ??
    countDiagnosticsWithSeverity(parsed, "warning");
  const blockingWarningKeys = collectBlockingWarningKeys(parsed);
  const warningCount = hasStructuredWarningFindings(parsed)
    ? blockingWarningKeys.length
    : rawWarningCount;
  const explicitErrorCount =
    readNumericCount(parsed, "errorCount") ??
    readNestedNumericCount(parsed, "summary", "errorCount") ??
    readNestedNumericCount(parsed, "summary", "breakageCount") ??
    readArrayCount(parsed, "errors") ??
    countDiagnosticsWithSeverity(parsed, "error");
  const status = readStringField(parsed, "status");
  const errorCount =
    status && status !== "pass" ? Math.max(explicitErrorCount, 1) : explicitErrorCount;

  return { warningCount, errorCount, blockingWarningKeys };
}

function isClawHubPluginValidationRelevantPath(path: string) {
  const normalized = path.trim().replaceAll("\\", "/");
  return !normalized.endsWith("/npm-shrinkwrap.json");
}

export function parseValidateChangedClawHubPluginsArgs(argv: string[]): ValidateArgs {
  const args: ValidateArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    }
    if (arg === "--base-ref") {
      args.baseRef = readRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--head-ref") {
      args.headRef = readRequiredArgValue(argv, index, arg);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return args;
}

export function runClawHubPackageValidate(packageDir: string, cwd = ".") {
  const current = executeClawHubPackageValidate(packageDir, cwd);
  if (current.warningCount > 0 || current.errorCount > 0) {
    throw new Error(
      `${packageDir}: ClawHub validation reported ${formatCount(current.warningCount, "warning")} and ${formatCount(current.errorCount, "error")}.`,
    );
  }
}

function executeClawHubPackageValidate(packageDir: string, cwd = ".") {
  const reportDir = mkdtempSync(join(tmpdir(), "openclaw-clawhub-validate-"));
  try {
    const { command, args } = buildClawHubPackageValidateCommand(packageDir, reportDir, cwd);
    const result = spawnSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (result.stdout.trim()) {
      process.stdout.write(`${result.stdout.trim()}\n`);
    }
    if (result.stderr.trim()) {
      process.stderr.write(`${result.stderr.trim()}\n`);
    }
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(
        `${packageDir}: clawhub package validate failed with exit code ${result.status}.`,
      );
    }
    return parseClawHubValidationReport(result.stdout, packageDir);
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
}

function runClawHubPackageValidateAgainstBaseline(params: {
  packageDir: string;
  cwd: string;
  baselineRef: string;
}) {
  const current = executeClawHubPackageValidate(params.packageDir, params.cwd);
  if (current.errorCount > 0) {
    throw new Error(
      `${params.packageDir}: ClawHub validation reported ${formatCount(current.warningCount, "warning")} and ${formatCount(current.errorCount, "error")}.`,
    );
  }
  if (current.warningCount === 0) {
    return;
  }

  const baselineWarnings = new Set(
    collectBaselineBlockingWarningKeys({
      packageDir: params.packageDir,
      cwd: params.cwd,
      baselineRef: params.baselineRef,
    }),
  );
  if (current.blockingWarningKeys.length === 0) {
    throw new Error(
      `${params.packageDir}: ClawHub validation reported ${formatCount(current.warningCount, "warning")} and ${formatCount(current.errorCount, "error")}.`,
    );
  }
  const newWarnings = current.blockingWarningKeys.filter((key) => !baselineWarnings.has(key));
  if (newWarnings.length > 0) {
    throw new Error(
      `${params.packageDir}: ClawHub validation reported ${formatCount(newWarnings.length, "new warning")} and ${formatCount(current.errorCount, "error")}.`,
    );
  }

  console.log(
    `validate-changed-clawhub-plugins: ${params.packageDir} has ${formatCount(current.warningCount, "pre-existing warning")}; no new ClawHub warnings.`,
  );
}

function collectBaselineBlockingWarningKeys(params: {
  packageDir: string;
  cwd: string;
  baselineRef: string;
}) {
  const rootDir = resolve(params.cwd);
  const baselineSha = resolveGitCommitSha(rootDir, params.baselineRef, "baselineRef");
  const tempRoot = mkdtempSync(join(tmpdir(), "openclaw-clawhub-baseline-"));
  try {
    const archive = execFileSync(
      "git",
      ["archive", "--format=tar", baselineSha, params.packageDir],
      {
        cwd: rootDir,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const tar = spawnSync("tar", ["-xf", "-", "-C", tempRoot], {
      input: archive,
      stdio: ["pipe", "ignore", "pipe"],
    });
    if (tar.error) {
      throw tar.error;
    }
    if (tar.status !== 0) {
      throw new Error(`${params.packageDir}: failed to extract baseline package.`);
    }
    const baselinePackageDir = join(tempRoot, params.packageDir);
    return executeClawHubPackageValidate(baselinePackageDir, rootDir).blockingWarningKeys;
  } catch {
    return [];
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function runValidateChangedClawHubPlugins(argv: string[]) {
  const { baseRef = "origin/main", headRef = "HEAD" } =
    parseValidateChangedClawHubPluginsArgs(argv);
  const rootDir = resolve(".");
  const gitRange = { baseRef, headRef };
  const changedPaths = collectClawHubPluginValidationPathsFromGitRange({ rootDir, gitRange });
  const plan = createChangedClawHubPackageValidatePlan({
    plugins: collectClawHubPublishablePluginPackages(rootDir),
    changedPaths,
  });
  assertNoRemovedClawHubPublishablePackages({
    currentPlan: plan,
    baselinePlugins: collectBaselineClawHubPublishablePluginPackages({
      rootDir,
      baselineRef: baseRef,
    }),
    changedPaths,
  });

  if (plan.length === 0) {
    console.log(
      `validate-changed-clawhub-plugins: no changed ClawHub-publishable plugin packages between ${baseRef} and ${headRef}.`,
    );
    return;
  }

  for (const plugin of plan) {
    console.log(
      `validate-changed-clawhub-plugins: validating ${plugin.packageName} (${plugin.packageDir})`,
    );
    runClawHubPackageValidateAgainstBaseline({
      packageDir: plugin.packageDir,
      cwd: ".",
      baselineRef: baseRef,
    });
  }
  console.log(
    `validate-changed-clawhub-plugins: validated ${formatCount(plan.length, "plugin package")}.`,
  );
}

function parseJsonObject(output: string, packageDir: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // Fall through to the contextual error below.
  }
  throw new Error(`${packageDir}: ClawHub validation did not return a JSON object.`);
}

function readBaselineClawHubPublishablePackage(params: {
  rootDir: string;
  baselineSha: string;
  packagePath: string;
}): ChangedClawHubPackageValidatePlanItem[] {
  const match = /^extensions\/([^/]+)\/package\.json$/u.exec(params.packagePath);
  const extensionId = match?.[1];
  if (!extensionId) {
    return [];
  }

  const raw = execFileSync("git", ["show", `${params.baselineSha}:${params.packagePath}`], {
    cwd: params.rootDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const packageJson = parseJsonRecordOrNull(raw);
  if (!packageJson) {
    return [];
  }

  const openclaw = readRecordField(packageJson, "openclaw");
  const release = openclaw ? readRecordField(openclaw, "release") : undefined;
  if (release?.publishToClawHub !== true) {
    return [];
  }

  const packageName = readStringField(packageJson, "name")?.trim() || params.packagePath;
  return [
    {
      extensionId,
      packageDir: `extensions/${extensionId}`,
      packageName,
    },
  ];
}

function collectChangedExtensionIdsForClawHubValidation(changedPaths: readonly string[]) {
  return new Set(
    changedPaths.filter(isClawHubPluginValidationRelevantPath).flatMap((path) => {
      const match = /^extensions\/([^/]+)\//u.exec(path.trim().replaceAll("\\", "/"));
      return match?.[1] ? [match[1]] : [];
    }),
  );
}

function parseJsonRecordOrNull(output: string) {
  try {
    const parsed = JSON.parse(output) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readRecordField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return field && typeof field === "object" && !Array.isArray(field)
    ? (field as Record<string, unknown>)
    : undefined;
}

function readNumericCount(value: Record<string, unknown>, key: string) {
  const count = value[key];
  return typeof count === "number" && Number.isFinite(count) ? count : undefined;
}

function readNestedNumericCount(value: Record<string, unknown>, parentKey: string, key: string) {
  const parent = value[parentKey];
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    return undefined;
  }
  return readNumericCount(parent as Record<string, unknown>, key);
}

function readArrayCount(value: Record<string, unknown>, key: string) {
  const items = value[key];
  return Array.isArray(items) ? items.length : undefined;
}

function readStringField(value: Record<string, unknown>, key: string) {
  const field = value[key];
  return typeof field === "string" ? field : undefined;
}

function hasStructuredWarningFindings(value: Record<string, unknown>) {
  return (
    Array.isArray(value.issues) ||
    Array.isArray(value.warnings) ||
    collectDiagnosticWarnings(value).length > 0
  );
}

function collectBlockingWarningKeys(value: Record<string, unknown>) {
  return [...collectIssueLikeWarnings(value), ...collectDiagnosticWarnings(value)].flatMap(
    (warning) => {
      if (!warning || typeof warning !== "object" || Array.isArray(warning)) {
        return ["unknown-issue"];
      }
      const record = warning as Record<string, unknown>;
      return isIgnoredCompatibilityWarning(record) ? [] : [formatWarningKey(record)];
    },
  );
}

function collectIssueLikeWarnings(value: Record<string, unknown>) {
  return [value.issues, value.warnings].flatMap((items) => (Array.isArray(items) ? items : []));
}

function collectDiagnosticWarnings(value: Record<string, unknown>) {
  const diagnostics = value.diagnostics;
  if (!Array.isArray(diagnostics)) {
    return [];
  }
  return diagnostics.filter((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object" || Array.isArray(diagnostic)) {
      return false;
    }
    return readDiagnosticSeverity(diagnostic) === "warning";
  });
}

function formatWarningKey(issue: Record<string, unknown>) {
  const fields = ["owner", "code", "decision", "issueClass"].map(
    (field) => `${field}:${readStringField(issue, field) ?? ""}`,
  );
  const evidence = issue.evidence;
  if (Array.isArray(evidence)) {
    fields.push(
      `evidence:${evidence
        .map((item) => String(item))
        .toSorted()
        .join("|")}`,
    );
  }
  return fields.join(";");
}

function isIgnoredCompatibilityWarning(issue: Record<string, unknown>) {
  const owner = readStringField(issue, "owner");
  const decision = readStringField(issue, "decision");
  const issueClass = readStringField(issue, "issueClass");
  const code = readStringField(issue, "code");
  return (
    (owner === "core" && decision === "core-compat-adapter") ||
    (issueClass === "deprecation-warning" &&
      (code === "channel-env-vars" || code === "provider-auth-env-vars"))
  );
}

function countDiagnosticsWithSeverity(
  value: Record<string, unknown>,
  severity: "error" | "warning",
) {
  const diagnostics = value.diagnostics ?? value.issues;
  if (!Array.isArray(diagnostics)) {
    return 0;
  }
  return diagnostics.filter((diagnostic) => {
    if (!diagnostic || typeof diagnostic !== "object") {
      return false;
    }
    return readDiagnosticSeverity(diagnostic) === severity;
  }).length;
}

function readDiagnosticSeverity(diagnostic: object) {
  return (
    (diagnostic as { severity?: unknown; level?: unknown }).severity ??
    (diagnostic as { severity?: unknown; level?: unknown }).level
  );
}

function formatCount(count: number, label: string) {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function readRequiredArgValue(argv: string[], index: number, flag: string) {
  const value = argv[index + 1]?.trim();
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function printHelp() {
  console.log(`Usage: node --import tsx scripts/validate-changed-clawhub-plugins.ts [--base-ref <ref>] [--head-ref <ref>]

Runs a pinned ClawHub CLI against ClawHub-publishable plugin packages
changed between the selected git refs.`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runValidateChangedClawHubPlugins(process.argv.slice(2));
}
