// Runs oxlint with local resource policy, sparse-checkout filtering, and
// plugin package-boundary artifact preparation when needed.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import JSON5 from "json5";
import type { DummyRuleMap, OxlintConfig } from "oxlint";
import { ensureKyselyTypes } from "./generate-kysely-types.mts";
import { limitsAreAdvisory, reportLimitViolations } from "./lib/check-limits.mts";
import { parseStaticDiagnostics } from "./lib/ci-static-check-evidence.mjs";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import {
  distArtifactEntryArgs,
  resolveDistArtifactLockPath,
  withDistArtifactOwnership,
} from "./lib/dist-artifact-ownership.mts";
import {
  applyLocalOxlintPolicy,
  resolveLocalCheckEnv,
  resolveRepoToolBinPath,
} from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation, runManagedCommand } from "./lib/managed-child-process.mts";
import { resolveUntouchedOxlintExclusions } from "./lib/oxlint-changed-scope.mts";
import { readProcessMemoryCapacity } from "./lib/process-memory.mts";
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

type OxlintRunResult = {
  status: number;
  evidence?: {
    version: 1;
    id: string;
    config: string;
    exitCode: number;
    stdout: string;
    stderr: string;
  };
};

const MAX_REPORT_BYTES = 1024 * 1024;

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

function advisoryLimitRules(rules: DummyRuleMap | undefined, onlyMaxLines = false) {
  const overrides: DummyRuleMap = {};
  const originalRules: DummyRuleMap = {};
  let enabled = false;
  for (const [name, rule] of Object.entries(rules ?? {})) {
    const id = name.startsWith("eslint/") ? name.slice("eslint/".length) : name;
    if (!LIMIT_RULES.has(id) || (onlyMaxLines && id !== "max-lines")) {
      continue;
    }
    originalRules[name] = rule;
    overrides[name] = rule;
    const severity = Array.isArray(rule) ? rule[0] : rule;
    // Replay disabled scopes too: a later exclusion must still override an earlier limit.
    if (
      !(
        severity === "warn" ||
        severity === "error" ||
        severity === "deny" ||
        severity === 1 ||
        severity === 2
      )
    ) {
      continue;
    }
    overrides[name] = Array.isArray(rule) ? ["warn", ...rule.slice(1)] : "warn";
    enabled = true;
  }
  return { rules: overrides, originalRules, enabled };
}

async function runWithAdvisoryLimits(
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  ownedDirectory?: string,
): Promise<OxlintRunResult> {
  const configOption = oxlintOption(args, "--config", "-c");
  const configPath = path.resolve(configOption.value ?? ".oxlintrc.json");
  const command = {
    bin,
    args,
    env,
    requireProcessTreeExit: process.platform !== "win32",
  };
  const evidenceId = env.OPENCLAW_CI_STATIC_EVIDENCE_ID;
  const evidenceEnabled =
    env.OPENCLAW_CI_STATIC_EVIDENCE === "1" &&
    typeof evidenceId === "string" &&
    /^[\w:-]{1,160}$/u.test(evidenceId) &&
    !args.some((arg) => /^(?:--output-file|--fix(?:-suggestions|-dangerously)?)(?:=|$)/u.test(arg));
  const githubAdvisory = limitsAreAdvisory(env);
  let untouchedExclusions = githubAdvisory
    ? undefined
    : resolveUntouchedOxlintExclusions(configPath, env);
  if (
    (!githubAdvisory && !untouchedExclusions && !evidenceEnabled) ||
    args.some((arg) => OXLINT_PREPARE_SKIP_FLAGS.has(arg.replace(/[=][\s\S]*$/u, ""))) ||
    !fs.existsSync(configPath)
  ) {
    return { status: await runManagedCommand(command) };
  }
  const config = JSON5.parse<OxlintConfig>(fs.readFileSync(configPath, "utf8"));
  // A child alone cannot replay inherited cap exceptions or disabled scopes safely.
  if (!githubAdvisory && config.extends?.length) {
    untouchedExclusions = undefined;
  }
  const rootRules = advisoryLimitRules(config.rules, !githubAdvisory);
  let enabled = rootRules.enabled;
  const overrides: NonNullable<OxlintConfig["overrides"]> = [];
  if (untouchedExclusions && rootRules.enabled) {
    overrides.push({
      files: ["**/*"],
      excludeFiles: untouchedExclusions,
      rules: rootRules.rules,
    });
  }
  for (const scope of config.overrides ?? []) {
    const scopedRules = advisoryLimitRules(scope.rules, !githubAdvisory);
    enabled ||= scopedRules.enabled;
    if (Object.keys(scopedRules.rules).length === 0) {
      continue;
    }
    if (untouchedExclusions) {
      overrides.push({
        files: scope.files,
        excludeFiles: scope.excludeFiles,
        rules: scopedRules.originalRules,
      });
    }
    overrides.push({
      files: scope.files,
      excludeFiles: untouchedExclusions
        ? [...(scope.excludeFiles ?? []), ...untouchedExclusions]
        : scope.excludeFiles,
      rules: scopedRules.rules,
    });
  }
  enabled &&= githubAdvisory || Boolean(untouchedExclusions);
  if (!enabled && !evidenceEnabled) {
    return { status: await runManagedCommand(command) };
  }

  if (enabled) {
    const configRoot = fs.realpathSync(path.dirname(configPath));
    const directory = resolveDistArtifactLockPath(configRoot);
    if (ownedDirectory !== directory) {
      // Oxlint anchors inherited globs at this directory. Keep its transient
      // config here, but exclude compilers from the entire create/remove lifetime.
      return await withDistArtifactOwnership(configRoot, () =>
        runWithAdvisoryLimits(bin, args, env, directory),
      );
    }
  }

  // CLI --warn cannot replace scoped severities and enables rules outside their file scopes.
  // Keep the transient config beside its owner so relative globs and plugin paths do not move.
  const advisoryConfig = enabled
    ? path.join(path.dirname(configPath), `.oxlint-limits-${randomUUID()}.json`)
    : undefined;
  // Extending the original preserves native syntax/schema validation before the override.
  if (advisoryConfig) {
    fs.writeFileSync(
      advisoryConfig,
      JSON.stringify({
        extends: [configPath],
        rules: githubAdvisory ? rootRules.rules : undefined,
        overrides,
        plugins: config.plugins,
        categories: config.categories,
        // Oxlint 1.82 keeps these fields from the child rather than inheriting them.
        env: config.env,
        globals: config.globals,
        settings: config.settings,
        ignorePatterns: config.ignorePatterns,
      }),
      { flag: "wx" },
    );
  }
  const outputListeners = new Set<() => void>();
  const forward = (source: Readable, target: NodeJS.WriteStream, chunk: string) => {
    if (!chunk || target.write(chunk)) {
      return;
    }
    source.pause();
    const remove = () => target.off("drain", resume);
    const resume = () => {
      outputListeners.delete(remove);
      source.resume();
    };
    outputListeners.add(remove);
    target.once("drain", resume);
  };
  try {
    const configuredArgs = advisoryConfig ? configOption.replace(advisoryConfig) : args;
    if (!githubAdvisory && !evidenceEnabled) {
      return { status: await runManagedCommand({ ...command, args: configuredArgs }) };
    }
    const format = oxlintOption(configuredArgs, "--format", "-f");
    let output = "";
    let stderr = "";
    let overflow = false;
    let capturedBytes = 0;
    const status = await runManagedCommand({
      ...command,
      args: format.replace("json"),
      stdio: ["inherit", "pipe", evidenceEnabled ? "pipe" : "inherit"],
      onReady(child) {
        if (!child.stdout) {
          throw new Error("Oxlint JSON report pipe is unavailable");
        }
        const stdout = child.stdout;
        const capture = (chunk: string) => {
          capturedBytes += Buffer.byteLength(chunk);
          if (!overflow && capturedBytes > MAX_REPORT_BYTES) {
            overflow = true;
            forward(stdout, process.stdout, output);
            output = "";
            stderr = "";
          }
        };
        stdout.setEncoding("utf8");
        stdout.on("data", (chunk: string) => {
          capture(chunk);
          if (overflow) {
            // The supervisor lives outside the compiler's memory scope. Bound
            // both its report capture and its queue to a slow output consumer.
            forward(stdout, process.stdout, chunk);
          } else {
            output += chunk;
          }
        });
        if (evidenceEnabled) {
          if (!child.stderr) {
            throw new Error("Oxlint diagnostic error pipe is unavailable");
          }
          const errors = child.stderr;
          errors.setEncoding("utf8");
          errors.on("data", (chunk: string) => {
            forward(errors, process.stderr, chunk);
            capture(chunk);
            if (!overflow) {
              stderr += chunk;
            }
          });
        }
      },
    });
    if (overflow) {
      if (enabled) {
        reportLimitViolations(
          [
            {
              file: path.relative(process.cwd(), configPath),
              title: "Oxlint advisory report exceeded capture limit",
              message:
                "The report exceeded 1 MiB. Individual advisory annotations and static evidence were skipped; the complete report was streamed to the job log.",
            },
          ],
          env,
        );
      }
      return { status };
    }
    if (status !== 0 && status !== 1) {
      process.stdout.write(output);
      return { status };
    }
    let report: { diagnostics: OxlintDiagnostic[] };
    try {
      report = JSON5.parse(output);
    } catch (error) {
      // Configuration failures can be plain text even when JSON output was requested.
      process.stdout.write(output);
      if (status !== 0) {
        return { status };
      }
      throw error;
    }
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
    if (evidenceEnabled || format.value === "json") {
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
    const diagnostics = evidenceEnabled ? parseStaticDiagnostics(output, "oxlint") : null;
    return {
      status,
      ...(evidenceEnabled &&
      stderr === "" &&
      diagnostics !== null &&
      (status === 0 ? diagnostics.length === 0 : diagnostics.length > 0)
        ? {
            evidence: {
              version: 1,
              id: evidenceId,
              config:
                oxlintOption(args, "--tsconfig", "").value ??
                configOption.value ??
                ".oxlintrc.json",
              exitCode: status,
              stdout: output,
              stderr,
            },
          }
        : {}),
    };
  } finally {
    for (const remove of outputListeners) {
      remove();
    }
    if (advisoryConfig) {
      fs.unlinkSync(advisoryConfig);
    }
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
export async function runOxlint(
  argv: string[] = process.argv.slice(2),
  runtimeEnv: NodeJS.ProcessEnv = process.env,
): Promise<OxlintRunResult> {
  const focusedConfig = argv.includes(OPENCLAW_FOCUSED_CONFIG_FLAG);
  const oxlintArgs = argv.filter((arg) => arg !== OPENCLAW_FOCUSED_CONFIG_FLAG);
  const localEnv = resolveLocalCheckEnv(runtimeEnv);
  const memory = focusedConfig ? null : readProcessMemoryCapacity({});
  // Focused configs are syntax-only guards; keep wrapper process handling
  // without the broad type-aware policy or package artifact preparation.
  const { args: policyArgs, env } = focusedConfig
    ? { args: oxlintArgs, env: localEnv }
    : applyLocalOxlintPolicy(oxlintArgs, localEnv, {
        logicalCpuCount: os.availableParallelism(),
        totalMemoryBytes: os.totalmem(),
        memoryCapacityBytes: memory?.capacityBytes,
        memoryLimitBytes:
          memory?.usageKnown && memory.availableBytes !== null ? memory.limitBytes : null,
        platform: process.platform,
      });
  const sparseTargets = filterSparseMissingOxlintTargets(policyArgs);
  const finalArgs = sparseTargets.args;
  const oxlintPath = resolveRepoToolBinPath("oxlint");
  const needsArtifactPreparation =
    !focusedConfig &&
    env.OPENCLAW_OXLINT_SKIP_PREPARE !== "1" &&
    shouldPrepareExtensionPackageBoundaryArtifacts(finalArgs);
  if (sparseTargets.skippedTargets.length > 0) {
    delete env.OPENCLAW_CI_STATIC_EVIDENCE;
    console.error(
      `[oxlint] sparse checkout is missing tracked target(s); skipping ${sparseTargets.skippedTargets.join(", ")}`,
    );
  }
  if (sparseTargets.skippedConfigs.length > 0) {
    console.error(
      `[oxlint] sparse checkout is missing tracked config(s); skipping oxlint: ${sparseTargets.skippedConfigs.join(", ")}`,
    );
    return { status: 0 };
  }
  if (sparseTargets.hadExplicitTargets && sparseTargets.remainingExplicitTargets === 0) {
    console.error("[oxlint] no present sparse-checkout targets remain; skipping oxlint.");
    return { status: 0 };
  }

  const root = process.cwd();
  const run = async (ownedDirectory?: string) => {
    if (!focusedConfig) {
      // Type-aware rules resolve Kysely schema projections, which are generated, not tracked.
      await ensureKyselyTypes(root);
    }
    if (needsArtifactPreparation) {
      // Declaration compilation owns its Go policy; lint limits belong to the oxlint child.
      await prepareExtensionPackageBoundaryArtifacts(localEnv);
    }
    return await runWithAdvisoryLimits(
      oxlintPath,
      finalArgs,
      resolveOxlintToolchainEnv(oxlintPath, env),
      ownedDirectory,
    );
  };
  // Skip-prepare callers still consume shared declarations. Hold one owner across
  // preparation and lint; source-only lint acquires it only for transient config.
  return !focusedConfig && shouldPrepareExtensionPackageBoundaryArtifacts(argv)
    ? await withDistArtifactOwnership(root, () => run(resolveDistArtifactLockPath(root)))
    : await run();
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const result = await runOxlint();
  process.exitCode = result.status;
  if (result.evidence) {
    console.log(`\n[ci-static:oxlint:leaf] ${JSON.stringify(result.evidence)}`);
  }
}
