import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
} from "./local-heavy-check-runtime.mjs";

const PLUGIN_SDK_DTS_STAMP = path.join("dist", "plugin-sdk", ".boundary-entry-shims.stamp");
const PLUGIN_SDK_DTS_ENTRY = path.join("dist", "plugin-sdk", "index.d.ts");
const PLUGIN_SDK_DTS_INPUT_FILES = [
  "tsconfig.plugin-sdk.dts.json",
  path.join("scripts", "write-plugin-sdk-entry-dts.ts"),
  path.join("scripts", "lib", "plugin-sdk-entries.mjs"),
  path.join("scripts", "lib", "plugin-sdk-entrypoints.json"),
];
const PLUGIN_SDK_DTS_SOURCE_ROOTS = ["src", path.join("packages", "memory-host-sdk", "src")];

export function runExtensionOxlint(params) {
  const repoRoot = process.cwd();
  const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
  const releaseLock = acquireLocalHeavyCheckLockSync({
    cwd: repoRoot,
    env: process.env,
    toolName: params.toolName,
    lockName: params.lockName,
  });
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), params.tempDirPrefix));
  const tempConfigPath = path.join(tempDir, "oxlint.json");

  try {
    ensurePluginSdkDeclarationOutputs({ repoRoot, toolName: params.toolName });

    const extensionFiles = params.roots.flatMap((root) =>
      collectTypeScriptFiles(path.resolve(repoRoot, root)),
    );

    if (extensionFiles.length === 0) {
      console.error(params.emptyMessage);
      process.exit(1);
    }

    writeTempOxlintConfig(repoRoot, tempConfigPath);

    const baseArgs = ["-c", tempConfigPath, ...process.argv.slice(2), ...extensionFiles];
    const { args: finalArgs, env } = applyLocalOxlintPolicy(baseArgs, process.env);
    const result = spawnSync(oxlintPath, finalArgs, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });

    if (result.error) {
      throw result.error;
    }

    process.exit(result.status ?? 1);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    releaseLock();
  }
}

export function resolvePluginSdkDeclarationBuildRequirement(params = {}) {
  const repoRoot = params.repoRoot ?? process.cwd();
  const fsImpl = params.fs ?? fs;
  const stampPath = path.join(repoRoot, PLUGIN_SDK_DTS_STAMP);
  const entryPath = path.join(repoRoot, PLUGIN_SDK_DTS_ENTRY);
  const stampMtime = readMtimeMs(fsImpl, stampPath);
  const entryMtime = readMtimeMs(fsImpl, entryPath);

  if (stampMtime == null || entryMtime == null) {
    return { shouldBuild: true, reason: "missing_declarations" };
  }

  const latestInputMtime = resolveLatestPluginSdkDeclarationInputMtime(repoRoot, fsImpl);
  if (latestInputMtime != null && latestInputMtime > stampMtime) {
    return { shouldBuild: true, reason: "stale_declarations" };
  }

  return { shouldBuild: false, reason: "fresh_declarations" };
}

function ensurePluginSdkDeclarationOutputs(params = {}) {
  const repoRoot = params.repoRoot ?? process.cwd();
  const env = params.env ?? process.env;
  const spawnSyncImpl = params.spawnSyncImpl ?? spawnSync;
  const requirement = resolvePluginSdkDeclarationBuildRequirement({ repoRoot });
  if (!requirement.shouldBuild) {
    return;
  }

  const releaseLock = acquireLocalHeavyCheckLockSync({
    cwd: repoRoot,
    env: { ...env, OPENCLAW_LOCAL_CHECK: "1" },
    toolName: `${params.toolName ?? "oxlint"}-plugin-sdk-dts`,
    lockName: "plugin-sdk-dts",
  });

  try {
    const currentRequirement = resolvePluginSdkDeclarationBuildRequirement({ repoRoot });
    if (!currentRequirement.shouldBuild) {
      return;
    }

    console.error(
      `[${params.toolName ?? "oxlint"}] building plugin-sdk declarations (${currentRequirement.reason})...`,
    );

    runRequiredCommand({
      command: path.resolve(
        repoRoot,
        "node_modules",
        ".bin",
        process.platform === "win32" ? "tsc.cmd" : "tsc",
      ),
      args: ["-p", "tsconfig.plugin-sdk.dts.json"],
      cwd: repoRoot,
      env,
      spawnSyncImpl,
      label: "build:plugin-sdk:dts",
    });
    runRequiredCommand({
      command: process.execPath,
      args: ["--import", "tsx", "scripts/write-plugin-sdk-entry-dts.ts"],
      cwd: repoRoot,
      env,
      spawnSyncImpl,
      label: "write-plugin-sdk-entry-dts",
    });
  } finally {
    releaseLock();
  }
}

function runRequiredCommand(params) {
  const result = params.spawnSyncImpl(params.command, params.args, {
    cwd: params.cwd,
    env: params.env,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    process.exit(result.status ?? 1);
  }
}

function writeTempOxlintConfig(repoRoot, configPath) {
  const config = JSON.parse(fs.readFileSync(path.resolve(repoRoot, ".oxlintrc.json"), "utf8"));

  delete config.$schema;

  if (Array.isArray(config.ignorePatterns)) {
    const extensionsIgnorePattern = config.ignorePatterns.find((pattern) =>
      isTopLevelExtensionsIgnorePattern(pattern),
    );
    if (extensionsIgnorePattern) {
      throw new Error(
        `Refusing to run extension oxlint with .oxlintrc.json ignore pattern ${JSON.stringify(
          extensionsIgnorePattern,
        )}. Remove the top-level extensions ignore so root and focused lint agree.`,
      );
    }
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function isTopLevelExtensionsIgnorePattern(pattern) {
  const normalized = pattern
    .trim()
    .replaceAll("\\", "/")
    .replaceAll(/^\.?\//g, "");
  return (
    normalized === "extensions" || normalized === "extensions/" || normalized === "extensions/**"
  );
}

function collectTypeScriptFiles(directoryPath) {
  const entries = fs.readdirSync(directoryPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(entryPath));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) {
      continue;
    }

    files.push(path.relative(process.cwd(), entryPath).split(path.sep).join("/"));
  }

  return files;
}

function resolveLatestPluginSdkDeclarationInputMtime(repoRoot, fsImpl) {
  let latestMtime = null;

  for (const inputPath of PLUGIN_SDK_DTS_INPUT_FILES) {
    latestMtime = maxMtime(latestMtime, readMtimeMs(fsImpl, path.join(repoRoot, inputPath)));
  }

  for (const root of PLUGIN_SDK_DTS_SOURCE_ROOTS) {
    latestMtime = maxMtime(
      latestMtime,
      findLatestMtime(path.join(repoRoot, root), fsImpl, shouldSkipPluginSdkDeclarationInput),
    );
  }

  return latestMtime;
}

function findLatestMtime(directoryPath, fsImpl, shouldSkip) {
  if (!fsImpl.existsSync(directoryPath)) {
    return null;
  }

  const entries = fsImpl.readdirSync(directoryPath, { withFileTypes: true });
  let latestMtime = null;

  for (const entry of entries) {
    const entryPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      latestMtime = maxMtime(latestMtime, findLatestMtime(entryPath, fsImpl, shouldSkip));
      continue;
    }

    if (!entry.isFile() || shouldSkip?.(entryPath)) {
      continue;
    }

    latestMtime = maxMtime(latestMtime, readMtimeMs(fsImpl, entryPath));
  }

  return latestMtime;
}

function shouldSkipPluginSdkDeclarationInput(entryPath) {
  return (
    entryPath.endsWith(".test.ts") ||
    entryPath.endsWith(".test.tsx") ||
    entryPath.endsWith(".e2e.test.ts") ||
    entryPath.endsWith(".live.test.ts")
  );
}

function readMtimeMs(fsImpl, filePath) {
  try {
    return fsImpl.statSync(filePath).mtimeMs;
  } catch {
    return null;
  }
}

function maxMtime(current, next) {
  if (next == null) {
    return current;
  }
  return current == null || next > current ? next : current;
}
