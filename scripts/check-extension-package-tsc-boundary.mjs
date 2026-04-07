#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import { dirname, join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const repoRoot = resolve(import.meta.dirname, "..");
const tscBin = require.resolve("typescript/bin/tsc");
const prepareBoundaryArtifactsBin = resolve(
  repoRoot,
  "scripts/prepare-extension-package-boundary-artifacts.mjs",
);
const extensionPackageBoundaryBaseConfig = "../tsconfig.package-boundary.base.json";
const FAILURE_OUTPUT_TAIL_LINES = 40;

function parseMode(argv) {
  const modeArg = argv.find((arg) => arg.startsWith("--mode="));
  const mode = modeArg?.slice("--mode=".length) ?? "all";
  if (!new Set(["all", "compile", "canary"]).has(mode)) {
    throw new Error(`Unknown mode: ${mode}`);
  }
  return mode;
}

function resolveCompileConcurrency() {
  const raw = process.env.OPENCLAW_EXTENSION_BOUNDARY_CONCURRENCY;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return Math.max(1, Math.min(6, Math.floor(os.availableParallelism() / 2)));
}

function readJsonFile(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function summarizeOutputSection(name, output) {
  const trimmed = output.trim();
  if (!trimmed) {
    return "";
  }

  const lines = trimmed.split("\n");
  if (lines.length <= FAILURE_OUTPUT_TAIL_LINES) {
    return `${name}:\n${trimmed}`;
  }

  const omittedLineCount = lines.length - FAILURE_OUTPUT_TAIL_LINES;
  const tail = lines.slice(-FAILURE_OUTPUT_TAIL_LINES).join("\n");
  return `${name}:\n[... ${omittedLineCount} earlier lines omitted ...]\n${tail}`;
}

function formatFailureFooter(params = {}) {
  const footerLines = [];
  if (params.kind) {
    footerLines.push(`kind: ${params.kind}`);
  }
  if (Number.isFinite(params.elapsedMs)) {
    footerLines.push(`elapsed: ${params.elapsedMs}ms`);
  }
  if (params.note) {
    footerLines.push(params.note);
  }
  return footerLines.join("\n");
}

export function formatBoundaryCheckSuccessSummary(params = {}) {
  const lines = ["extension package boundary check passed"];
  if (params.mode) {
    lines.push(`mode: ${params.mode}`);
  }
  if (Number.isInteger(params.compileCount)) {
    lines.push(`compiled plugins: ${params.compileCount}`);
  }
  if (Number.isInteger(params.canaryCount)) {
    lines.push(`canary plugins: ${params.canaryCount}`);
  }
  if (Number.isFinite(params.elapsedMs)) {
    lines.push(`elapsed: ${params.elapsedMs}ms`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatStepFailure(label, params = {}) {
  const stdoutSection = summarizeOutputSection("stdout", params.stdout ?? "");
  const stderrSection = summarizeOutputSection("stderr", params.stderr ?? "");
  const footer = formatFailureFooter(params);
  return [label, stdoutSection, stderrSection, footer].filter(Boolean).join("\n\n");
}

function attachStepFailureMetadata(error, label, params = {}) {
  error.stepLabel = label;
  error.kind = params.kind ?? "unknown";
  error.elapsedMs = params.elapsedMs ?? null;
  error.fullOutput = [label, params.stdout ?? "", params.stderr ?? "", formatFailureFooter(params)]
    .filter(Boolean)
    .join("\n")
    .trim();
  return error;
}

function collectBundledExtensionIds() {
  return readdirSync(join(repoRoot, "extensions"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

function resolveExtensionTsconfigPath(extensionId) {
  return join(repoRoot, "extensions", extensionId, "tsconfig.json");
}

function readExtensionTsconfig(extensionId) {
  return readJsonFile(resolveExtensionTsconfigPath(extensionId));
}

function collectOptInExtensionIds() {
  return collectBundledExtensionIds().filter((extensionId) => {
    const tsconfigPath = resolveExtensionTsconfigPath(extensionId);
    if (!existsSync(tsconfigPath)) {
      return false;
    }
    return readExtensionTsconfig(extensionId).extends === extensionPackageBoundaryBaseConfig;
  });
}

function collectCanaryExtensionIds(extensionIds) {
  return [
    ...new Map(
      extensionIds.map((extensionId) => [
        JSON.stringify(readExtensionTsconfig(extensionId)),
        extensionId,
      ]),
    ).values(),
  ];
}

function runNodeStep(label, args, timeoutMs) {
  const startedAt = Date.now();
  const result = spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });

  if (result.status === 0 && !result.error) {
    return result;
  }

  const timeoutSuffix =
    result.error?.name === "Error" && result.error.message.includes("ETIMEDOUT")
      ? `${label} timed out after ${timeoutMs}ms`
      : "";
  const errorSuffix = result.error ? result.error.message : "";
  const note = [timeoutSuffix, errorSuffix].filter(Boolean).join("\n");
  const elapsedMs = Date.now() - startedAt;
  const kind = timeoutSuffix ? "timeout" : result.error ? "spawn-error" : "nonzero-exit";
  const failure = attachStepFailureMetadata(
    new Error(
      formatStepFailure(label, {
        stdout: result.stdout,
        stderr: result.stderr,
        kind,
        elapsedMs,
        note,
      }),
    ),
    label,
    {
      stdout: result.stdout,
      stderr: result.stderr,
      kind,
      elapsedMs,
      note,
    },
  );
  failure.status = result.status ?? 1;
  throw failure;
}

function abortSiblingSteps(abortController) {
  if (abortController && !abortController.signal.aborted) {
    abortController.abort();
  }
}

export function runNodeStepAsync(label, args, timeoutMs, params = {}) {
  const abortController = params.abortController;
  const onFailure = params.onFailure;
  const startedAt = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: process.env,
      signal: abortController?.signal,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      child.kill("SIGTERM");
      settled = true;
      const error = attachStepFailureMetadata(
        new Error(
          formatStepFailure(label, {
            stdout,
            stderr,
            kind: "timeout",
            elapsedMs: Date.now() - startedAt,
            note: `${label} timed out after ${timeoutMs}ms`,
          }),
        ),
        label,
        {
          stdout,
          stderr,
          kind: "timeout",
          elapsedMs: Date.now() - startedAt,
          note: `${label} timed out after ${timeoutMs}ms`,
        },
      );
      onFailure?.(error);
      abortSiblingSteps(abortController);
      rejectPromise(error);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      if (error.name === "AbortError" && abortController?.signal.aborted) {
        rejectPromise(
          attachStepFailureMetadata(new Error(`${label} canceled after sibling failure`), label, {
            kind: "canceled",
            elapsedMs: Date.now() - startedAt,
            note: "canceled after sibling failure",
          }),
        );
        return;
      }
      const failure = attachStepFailureMetadata(
        new Error(
          formatStepFailure(label, {
            stdout,
            stderr,
            kind: "spawn-error",
            elapsedMs: Date.now() - startedAt,
            note: error.message,
          }),
        ),
        label,
        {
          stdout,
          stderr,
          kind: "spawn-error",
          elapsedMs: Date.now() - startedAt,
          note: error.message,
        },
      );
      onFailure?.(failure);
      abortSiblingSteps(abortController);
      rejectPromise(failure);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      clearTimeout(timer);
      settled = true;
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      const error = attachStepFailureMetadata(
        new Error(
          formatStepFailure(label, {
            stdout,
            stderr,
            kind: "nonzero-exit",
            elapsedMs: Date.now() - startedAt,
          }),
        ),
        label,
        {
          stdout,
          stderr,
          kind: "nonzero-exit",
          elapsedMs: Date.now() - startedAt,
        },
      );
      onFailure?.(error);
      abortSiblingSteps(abortController);
      rejectPromise(error);
    });
  });
}

export async function runNodeStepsWithConcurrency(steps, concurrency) {
  const abortController = new AbortController();
  let firstFailure = null;
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, steps.length) }, async () => {
    while (true) {
      if (abortController.signal.aborted) {
        return;
      }
      const index = nextIndex;
      nextIndex += 1;
      if (index >= steps.length) {
        return;
      }
      const step = steps[index];
      step.onStart?.();
      await runNodeStepAsync(step.label, step.args, step.timeoutMs, {
        abortController,
        onFailure(error) {
          firstFailure ??= error;
        },
      });
    }
  });
  await Promise.allSettled(workers);
  if (firstFailure) {
    throw firstFailure;
  }
}

export function resolveCanaryArtifactPaths(extensionId, rootDir = repoRoot) {
  const extensionRoot = resolve(rootDir, "extensions", extensionId);
  return {
    extensionRoot,
    canaryPath: resolve(extensionRoot, "__rootdir_boundary_canary__.ts"),
    tsconfigPath: resolve(extensionRoot, "tsconfig.rootdir-canary.json"),
  };
}

export function cleanupCanaryArtifacts(extensionId, rootDir = repoRoot) {
  const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId, rootDir);
  rmSync(canaryPath, { force: true });
  rmSync(tsconfigPath, { force: true });
}

export function cleanupCanaryArtifactsForExtensions(extensionIds, rootDir = repoRoot) {
  for (const extensionId of extensionIds) {
    cleanupCanaryArtifacts(extensionId, rootDir);
  }
}

export function installCanaryArtifactCleanup(extensionIds, params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const processObject = params.processObject ?? process;
  const exitHandler = () => {
    cleanupCanaryArtifactsForExtensions(extensionIds, rootDir);
  };
  processObject.on("exit", exitHandler);
  return () => {
    processObject.off("exit", exitHandler);
  };
}

function resolveBoundaryTsBuildInfoPath(extensionId) {
  return resolve(repoRoot, "extensions", extensionId, "dist", ".boundary-tsc.tsbuildinfo");
}

export function resolveBoundaryCheckLockPath(rootDir = repoRoot) {
  return resolve(rootDir, "dist", ".extension-package-boundary.lock");
}

export function acquireBoundaryCheckLock(params = {}) {
  const rootDir = params.rootDir ?? repoRoot;
  const processObject = params.processObject ?? process;
  const lockPath = resolveBoundaryCheckLockPath(rootDir);
  mkdirSync(dirname(lockPath), { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      throw attachStepFailureMetadata(
        new Error(
          [
            "extension package boundary check",
            "kind: lock-contention",
            `lock: ${lockPath}`,
            "another extension package boundary check is already running in this checkout",
          ].join("\n\n"),
          { cause: error },
        ),
        "extension package boundary check",
        {
          kind: "lock-contention",
          note: `lock: ${lockPath}\nanother extension package boundary check is already running in this checkout`,
        },
      );
    }
    throw error;
  }

  const release = () => {
    rmSync(lockPath, { force: true, recursive: true });
  };
  processObject.on("exit", release);
  return () => {
    processObject.off("exit", release);
    release();
  };
}

async function runCompileCheck(extensionIds) {
  process.stdout.write(
    `preparing plugin-sdk boundary artifacts for ${extensionIds.length} plugins\n`,
  );
  runNodeStep("plugin-sdk boundary prep", [prepareBoundaryArtifactsBin], 420_000);
  const concurrency = resolveCompileConcurrency();
  process.stdout.write(`compile concurrency ${concurrency}\n`);
  const steps = extensionIds.map((extensionId, index) => {
    const tsBuildInfoPath = resolveBoundaryTsBuildInfoPath(extensionId);
    mkdirSync(dirname(tsBuildInfoPath), { recursive: true });
    return {
      label: extensionId,
      onStart() {
        process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId}\n`);
      },
      args: [
        tscBin,
        "-p",
        resolve(repoRoot, "extensions", extensionId, "tsconfig.json"),
        "--noEmit",
        "--incremental",
        "--tsBuildInfoFile",
        tsBuildInfoPath,
      ],
      timeoutMs: 120_000,
    };
  });
  await runNodeStepsWithConcurrency(steps, concurrency);
}

function runCanaryCheck(extensionIds) {
  for (const extensionId of extensionIds) {
    const { canaryPath, tsconfigPath } = resolveCanaryArtifactPaths(extensionId);

    cleanupCanaryArtifacts(extensionId);
    try {
      writeFileSync(
        canaryPath,
        'import * as foo from "../../src/cli/acp-cli.ts";\nvoid foo;\nexport {};\n',
        "utf8",
      );
      writeFileSync(
        tsconfigPath,
        `${JSON.stringify(
          {
            extends: "./tsconfig.json",
            include: ["./__rootdir_boundary_canary__.ts"],
            exclude: [],
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const result = runNodeStep(
        `${extensionId} canary`,
        [tscBin, "-p", tsconfigPath, "--noEmit"],
        120_000,
      );
      throw new Error(
        `${extensionId} canary unexpectedly passed\n${result.stdout}${result.stderr}`,
      );
    } catch (error) {
      const output =
        error instanceof Error && typeof error.fullOutput === "string"
          ? error.fullOutput
          : String(error);
      if (!output.includes("TS6059") || !output.includes("src/cli/acp-cli.ts")) {
        throw error;
      }
    } finally {
      cleanupCanaryArtifacts(extensionId);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const startedAt = Date.now();
  const mode = parseMode(argv);
  const optInExtensionIds = collectOptInExtensionIds();
  const canaryExtensionIds = collectCanaryExtensionIds(optInExtensionIds);
  const cleanupExtensionIds = optInExtensionIds;
  const shouldRunCanary = mode === "all" || mode === "canary";
  const releaseBoundaryLock = acquireBoundaryCheckLock();
  const teardownCanaryCleanup = installCanaryArtifactCleanup(cleanupExtensionIds);

  try {
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
    if (mode === "all" || mode === "compile") {
      await runCompileCheck(optInExtensionIds);
    }
    if (shouldRunCanary) {
      runCanaryCheck(canaryExtensionIds);
    }
    process.stdout.write(
      formatBoundaryCheckSuccessSummary({
        mode,
        compileCount: mode === "canary" ? 0 : optInExtensionIds.length,
        canaryCount: shouldRunCanary ? canaryExtensionIds.length : 0,
        elapsedMs: Date.now() - startedAt,
      }),
    );
  } finally {
    releaseBoundaryLock?.();
    teardownCanaryCleanup?.();
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
  }
}

if (import.meta.main) {
  await main();
}
