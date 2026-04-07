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
      ? `\n${label} timed out after ${timeoutMs}ms`
      : "";
  const errorSuffix = result.error ? `\n${result.error.message}` : "";
  const failure = new Error(
    `${label}\n${result.stdout}${result.stderr}${timeoutSuffix}${errorSuffix}`.trim(),
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
      const error = new Error(
        `${label}\n${stdout}${stderr}\n${label} timed out after ${timeoutMs}ms`.trim(),
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
        rejectPromise(new Error(`${label} canceled after sibling failure`));
        return;
      }
      const failure = new Error(`${label}\n${stdout}${stderr}\n${error.message}`.trim());
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
      const error = new Error(`${label}\n${stdout}${stderr}`.trim());
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
      const output = error instanceof Error ? error.message : String(error);
      if (!output.includes("TS6059") || !output.includes("src/cli/acp-cli.ts")) {
        throw error;
      }
    } finally {
      cleanupCanaryArtifacts(extensionId);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const mode = parseMode(argv);
  const optInExtensionIds = collectOptInExtensionIds();
  const canaryExtensionIds = collectCanaryExtensionIds(optInExtensionIds);
  const cleanupExtensionIds = optInExtensionIds;
  const shouldRunCanary = mode === "all" || mode === "canary";
  const teardownCanaryCleanup = installCanaryArtifactCleanup(cleanupExtensionIds);

  try {
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
    if (mode === "all" || mode === "compile") {
      await runCompileCheck(optInExtensionIds);
    }
    if (shouldRunCanary) {
      runCanaryCheck(canaryExtensionIds);
    }
  } finally {
    teardownCanaryCleanup?.();
    cleanupCanaryArtifactsForExtensions(cleanupExtensionIds);
  }
}

if (import.meta.main) {
  await main();
}
