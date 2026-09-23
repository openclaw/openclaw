// Runs oxlint with local resource policy, sparse-checkout filtering, and
// plugin package-boundary artifact preparation when needed.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import type { DummyRuleMap, OxlintConfig } from "oxlint";
import { limitsAreAdvisory, reportLimitViolations } from "./lib/check-limits.mts";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import {
  applyLocalOxlintPolicy,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation, runManagedCommand } from "./lib/managed-child-process.mts";
import { resolvePathEnvKey } from "./windows-cmd-helpers.mjs";

const PREPARE_EXTENSION_BOUNDARY_ARGS = distArtifactEntryArgs(
  path.resolve("scripts", "prepare-extension-package-boundary-artifacts.mts"),
  ["--mode=package-boundary"],
);
const OXLINT_PREPARE_SKIP_FLAGS = new Set([
  "--help",
  "-h",
  "--version",
  "-V",
  "--print-config",
  "--rules",
  "--init",
  "--lsp",
]);
const OXLINT_VALUE_FLAGS = new Set([
  "--config",
  "--deny",
  "--env",
  "--format",
  "--globals",
  "--ignore-path",
  "--max-warnings",
  "--output-file",
  "--plugin",
  "--rules",
  "--tsconfig",
  "--warn",
]);
const OXLINT_BOUNDARY_FREE_TS_CONFIGS = new Set([
  "config/tsconfig/oxlint.core.json",
  "config/tsconfig/oxlint.scripts.json",
  "test/tsconfig/tsconfig.test.root.json",
]);
const OPENCLAW_FOCUSED_CONFIG_FLAG = "--openclaw-focused-config";
const LIMIT_RULES = new Set([
  "max-lines",
  "max-lines-per-function",
  "max-statements",
  "max-depth",
  "complexity",
]);

type OxlintDiagnostic = {
  filename: string;
  message: string;
  severity: string;
  code?: string;
  help?: string;
  labels?: { span: { line?: number; column?: number } }[];
};

function oxlintOption(args: string[], name: string, short: string) {
  const end = args.indexOf("--");
  const index = args.findIndex(
    (arg, position) =>
      (end === -1 || position < end) &&
      (arg === name || arg === short || arg.startsWith(`${name}=`)),
  );
  const option = args[index];
  const inline = option?.startsWith(`${name}=`) ?? false;
  return {
    value: index === -1 ? undefined : inline ? option?.slice(name.length + 1) : args[index + 1],
    replace(value: string) {
      const updated = args.slice();
      if (index === -1) {
        updated.splice(end === -1 ? args.length : end, 0, name, value);
      } else {
        updated.splice(index, inline ? 1 : 2, name, value);
      }
      return updated;
    },
  };
}

function warnOnConfiguredLimits(rules: DummyRuleMap | undefined): boolean {
  if (!rules) {
    return false;
  }
  let changed = false;
  for (const [name, rule] of Object.entries(rules)) {
    const id = name.startsWith("eslint/") ? name.slice("eslint/".length) : name;
    const severity = Array.isArray(rule) ? rule[0] : rule;
    if (!LIMIT_RULES.has(id) || severity === "off" || severity === "allow" || severity === 0) {
      continue;
    }
    rules[name] = Array.isArray(rule) ? ["warn", ...rule.slice(1)] : "warn";
    changed = true;
  }
  return changed;
}

async function runWithAdvisoryLimits(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<number> {
  const configOption = oxlintOption(args, "--config", "-c");
  const configPath = path.resolve(configOption.value ?? ".oxlintrc.json");
  const command = {
    bin,
    args,
    env,
    requireProcessTreeExit: process.platform !== "win32",
  };
  if (
    !limitsAreAdvisory(env) ||
    args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg)) ||
    !fs.existsSync(configPath)
  ) {
    return await runManagedCommand(command);
  }
  const config = JSON5.parse<OxlintConfig>(fs.readFileSync(configPath, "utf8"));
  const limitScopes = [config.rules, ...(config.overrides ?? []).map((override) => override.rules)];
  const changed = limitScopes.map(warnOnConfiguredLimits).some(Boolean);
  if (!changed) {
    return await runManagedCommand(command);
  }

  // CLI --warn cannot replace scoped severities and enables rules outside their file scopes.
  // Keep the transient config beside its owner so relative globs and plugin paths do not move.
  const advisoryConfig = path.join(path.dirname(configPath), `.oxlint-limits-${randomUUID()}.json`);
  fs.writeFileSync(advisoryConfig, JSON.stringify(config), { flag: "wx" });
  try {
    const configuredArgs = configOption.replace(advisoryConfig);
    const format = oxlintOption(configuredArgs, "--format", "-f");
    let output = "";
    const status = await runManagedCommand({
      ...command,
      args: format.replace("json"),
      stdio: ["inherit", "pipe", "inherit"],
      onReady(child) {
        if (!child.stdout) {
          throw new Error("Oxlint JSON report pipe is unavailable");
        }
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", (chunk: string) => {
          output += chunk;
        });
      },
    });
    if (status !== 0 && status !== 1) {
      process.stdout.write(output);
      return status;
    }
    const report = JSON5.parse<{ diagnostics: OxlintDiagnostic[] }>(output);
    const limits = report.diagnostics.filter((diagnostic) =>
      LIMIT_RULES.has(/^eslint\(([^)]+)\)$/u.exec(diagnostic.code ?? "")?.[1] ?? ""),
    );
    reportLimitViolations(
      limits.map((diagnostic) => ({
        file: diagnostic.filename.startsWith("file://")
          ? path.relative(process.cwd(), fileURLToPath(diagnostic.filename))
          : diagnostic.filename,
        title: `Oxlint ${diagnostic.code}`,
        message: [diagnostic.message, diagnostic.help].filter(Boolean).join(" "),
        line: diagnostic.labels?.[0]?.span.line,
      })),
      env,
    );
    if (format.value === "json") {
      process.stdout.write(output);
    } else {
      for (const diagnostic of report.diagnostics) {
        const position = diagnostic.labels?.[0]?.span;
        console.log(
          `${diagnostic.filename}:${position?.line ?? 1}:${position?.column ?? 0}: ${diagnostic.severity}: ${diagnostic.message} (${diagnostic.code ?? "oxlint"})`,
        );
        if (diagnostic.help) {
          console.log(`  ${diagnostic.help}`);
        }
      }
      const warnings = report.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "warning",
      ).length;
      const errors = report.diagnostics.filter(
        (diagnostic) => diagnostic.severity === "error",
      ).length;
      console.log(
        `Found ${warnings} warning${warnings === 1 ? "" : "s"} and ${errors} error${errors === 1 ? "" : "s"}.`,
      );
    }
    return status;
  } finally {
    fs.unlinkSync(advisoryConfig);
  }
}

/**
 * Returns whether oxlint args need package-boundary declaration artifacts first.
 */
export function shouldPrepareExtensionPackageBoundaryArtifacts(args: string[]) {
  if (args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg))) {
    return false;
  }

  const tsconfigs = args.flatMap((arg, index) => {
    if (arg === "--tsconfig") {
      const value = args[index + 1];
      return value === undefined ? [] : [value];
    }
    return arg.startsWith("--tsconfig=") ? [arg.slice("--tsconfig=".length)] : [];
  });
  // Core, script, and root-test lint resolve sources through the root tsconfig;
  // generated plugin package declarations are only an extension-lint input.
  return (
    tsconfigs.length === 0 ||
    tsconfigs.some((tsconfig) => !OXLINT_BOUNDARY_FREE_TS_CONFIGS.has(tsconfig))
  );
}

/**
 * Drops tracked-but-missing sparse-checkout targets so narrow sparse checks can pass.
 */
export function filterSparseMissingOxlintTargets(
  args: string[],
  {
    cwd = process.cwd(),
    fileExists = fs.existsSync,
    isSparseCheckoutEnabled = getSparseCheckoutEnabled,
    isTrackedPath = hasTrackedPath,
  }: Partial<{
    cwd?: string;
    fileExists?: (target: string) => boolean;
    isSparseCheckoutEnabled?: (params: { cwd: string }) => boolean;
    isTrackedPath?: (params: { cwd: string; target: string }) => boolean;
  }> = {},
) {
  if (!isSparseCheckoutEnabled({ cwd })) {
    return {
      args,
      hadExplicitTargets: false,
      remainingExplicitTargets: 0,
      skippedTargets: [],
      skippedConfigs: [],
    };
  }

  const filteredArgs = [];
  const skippedTargets = [];
  const skippedConfigs = [];
  let hadExplicitTargets = false;
  let remainingExplicitTargets = 0;
  let consumeNextValue = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    if (consumeNextValue) {
      filteredArgs.push(arg);
      consumeNextValue = false;
      continue;
    }

    if (arg === "--") {
      filteredArgs.push(arg);
      continue;
    }

    if (arg.startsWith("--")) {
      if (arg === "--tsconfig") {
        const value = args[index + 1];
        if (value !== undefined) {
          index += 1;
          if (!fileExists(path.resolve(cwd, value)) && isTrackedPath({ cwd, target: value })) {
            skippedConfigs.push(value);
            continue;
          }
          filteredArgs.push(arg, value);
          continue;
        }
      }
      if (arg.startsWith("--tsconfig=")) {
        const value = arg.slice("--tsconfig=".length);
        if (
          value &&
          !fileExists(path.resolve(cwd, value)) &&
          isTrackedPath({ cwd, target: value })
        ) {
          skippedConfigs.push(value);
          continue;
        }
      }
      filteredArgs.push(arg);
      if (!arg.includes("=") && OXLINT_VALUE_FLAGS.has(arg)) {
        consumeNextValue = true;
      }
      continue;
    }

    if (arg.startsWith("-")) {
      filteredArgs.push(arg);
      continue;
    }

    hadExplicitTargets = true;
    const absoluteTarget = path.resolve(cwd, arg);
    if (!fileExists(absoluteTarget) && isTrackedPath({ cwd, target: arg })) {
      skippedTargets.push(arg);
      continue;
    }

    remainingExplicitTargets += 1;
    filteredArgs.push(arg);
  }

  return {
    args: filteredArgs,
    hadExplicitTargets,
    remainingExplicitTargets,
    skippedTargets,
    skippedConfigs,
  };
}

function getSparseCheckoutEnabled({ cwd }: { cwd: string }) {
  const git = createManagedCommandInvocation({
    args: ["config", "--get", "--bool", "core.sparseCheckout"],
    bin: "git",
  });
  const result = spawnSync(git.command, git.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: git.shell,
    windowsVerbatimArguments: git.windowsVerbatimArguments,
  });

  return result.status === 0 && result.stdout.trim() === "true";
}

function hasTrackedPath({ cwd, target }: { cwd: string; target: string }) {
  const git = createManagedCommandInvocation({
    args: ["ls-files", "--", target],
    bin: "git",
  });
  const result = spawnSync(git.command, git.args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: git.shell,
    windowsVerbatimArguments: git.windowsVerbatimArguments,
  });

  return result.status === 0 && result.stdout.trim().length > 0;
}

function resolveOxlintToolchainEnv(
  oxlintPath: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
) {
  const pathKey = platform === "win32" ? resolvePathEnvKey(env) : "PATH";
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  const currentPath = env[pathKey]?.trim();
  return {
    ...env,
    // Type-aware oxlint resolves its optional tsgolint peer through PATH, so
    // keep the selected checkout's toolchain together in dependency-less worktrees.
    [pathKey]: [path.dirname(oxlintPath), currentPath].filter(Boolean).join(delimiter),
  };
}

async function prepareExtensionPackageBoundaryArtifacts(env: NodeJS.ProcessEnv) {
  const status = await runManagedCommand({
    bin: process.execPath,
    shell: false,
    args: PREPARE_EXTENSION_BOUNDARY_ARGS,
    env,
    requireProcessTreeExit: process.platform !== "win32",
  });

  if (status !== 0) {
    throw new Error(`prepare-extension-package-boundary-artifacts failed with exit code ${status}`);
  }
}

/**
 * Applies wrapper policy and runs oxlint with the final argument list.
 */
async function runOxlint(
  argv: string[] = process.argv.slice(2),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const focusedConfig = argv.includes(OPENCLAW_FOCUSED_CONFIG_FLAG);
  const oxlintArgs = argv.filter((arg) => arg !== OPENCLAW_FOCUSED_CONFIG_FLAG);
  const localEnv = resolveLocalCheckEnv(runtimeEnv);
  // Focused configs are syntax-only guards; keep wrapper process handling
  // without the broad type-aware policy or package artifact preparation.
  const { args: policyArgs, env } = focusedConfig
    ? { args: oxlintArgs, env: localEnv }
    : applyLocalOxlintPolicy(oxlintArgs, localEnv, {
        logicalCpuCount: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(),
      });
  const sparseTargets = filterSparseMissingOxlintTargets(policyArgs);
  const finalArgs = sparseTargets.args;
  const oxlintPath = resolveRepoToolBinPath("oxlint");
  const needsArtifactPreparation =
    !focusedConfig &&
    env.OPENCLAW_OXLINT_SKIP_PREPARE !== "1" &&
    shouldPrepareExtensionPackageBoundaryArtifacts(finalArgs);
  if (sparseTargets.skippedTargets.length > 0) {
    console.error(
      `[oxlint] sparse checkout is missing tracked target(s); skipping ${sparseTargets.skippedTargets.join(", ")}`,
    );
  }
  if (sparseTargets.skippedConfigs.length > 0) {
    console.error(
      `[oxlint] sparse checkout is missing tracked config(s); skipping oxlint: ${sparseTargets.skippedConfigs.join(", ")}`,
    );
    return 0;
  }
  if (sparseTargets.hadExplicitTargets && sparseTargets.remainingExplicitTargets === 0) {
    console.error("[oxlint] no present sparse-checkout targets remain; skipping oxlint.");
    return 0;
  }

  if (needsArtifactPreparation) {
    // Declaration compilation owns its Go policy; lint limits belong to the oxlint child.
    await prepareExtensionPackageBoundaryArtifacts(localEnv);
  }
  return await runWithAdvisoryLimits(
    oxlintPath,
    finalArgs,
    resolveOxlintToolchainEnv(oxlintPath, env),
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const argv = process.argv.slice(2);
  // Skip-prepare callers still consume shared declarations. Source-only lint
  // remains independent; sharded lint inherits its parent's owner.
  process.exitCode =
    !argv.includes(OPENCLAW_FOCUSED_CONFIG_FLAG) &&
    shouldPrepareExtensionPackageBoundaryArtifacts(argv)
      ? await withDistArtifactOwnership(process.cwd(), () => runOxlint(argv))
      : await runOxlint(argv);
}
