#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
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

function cleanupCanaryArtifacts(extensionId) {
  const extensionRoot = resolve(repoRoot, "extensions", extensionId);
  rmSync(resolve(extensionRoot, "__rootdir_boundary_canary__.ts"), { force: true });
  rmSync(resolve(extensionRoot, "tsconfig.rootdir-canary.json"), { force: true });
}

function resolveBoundaryTsBuildInfoPath(extensionId) {
  return resolve(repoRoot, "extensions", extensionId, "dist", ".boundary-tsc.tsbuildinfo");
}

function runCompileCheck(extensionIds) {
  process.stdout.write(
    `preparing plugin-sdk boundary artifacts for ${extensionIds.length} plugins\n`,
  );
  runNodeStep("plugin-sdk boundary prep", [prepareBoundaryArtifactsBin], 420_000);
  for (const [index, extensionId] of extensionIds.entries()) {
    const tsBuildInfoPath = resolveBoundaryTsBuildInfoPath(extensionId);
    mkdirSync(dirname(tsBuildInfoPath), { recursive: true });
    process.stdout.write(`[${index + 1}/${extensionIds.length}] ${extensionId}\n`);
    runNodeStep(
      extensionId,
      [
        tscBin,
        "-p",
        resolve(repoRoot, "extensions", extensionId, "tsconfig.json"),
        "--noEmit",
        "--incremental",
        "--tsBuildInfoFile",
        tsBuildInfoPath,
      ],
      120_000,
    );
  }
}

function runCanaryCheck(extensionIds) {
  for (const extensionId of extensionIds) {
    const extensionRoot = resolve(repoRoot, "extensions", extensionId);
    const canaryPath = resolve(extensionRoot, "__rootdir_boundary_canary__.ts");
    const tsconfigPath = resolve(extensionRoot, "tsconfig.rootdir-canary.json");

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

function main() {
  const mode = parseMode(process.argv.slice(2));
  const optInExtensionIds = collectOptInExtensionIds();
  const canaryExtensionIds = collectCanaryExtensionIds(optInExtensionIds);

  if (mode === "all" || mode === "compile") {
    runCompileCheck(optInExtensionIds);
  }
  if (mode === "all" || mode === "canary") {
    runCanaryCheck(canaryExtensionIds);
  }
}

main();
