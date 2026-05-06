import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
} from "./local-heavy-check-runtime.mjs";

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
  let exitCode = 0;

  try {
    prepareExtensionPackageBoundaryArtifacts(repoRoot);

    const extensionFiles = collectTrackedTypeScriptFiles(repoRoot, params.roots);

    if (extensionFiles.length === 0) {
      console.log(params.emptyMessage);
      if (params.allowEmpty === true) {
        return;
      }
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

    exitCode = result.status ?? 1;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    releaseLock();
  }

  process.exitCode = exitCode;
}

function prepareExtensionPackageBoundaryArtifacts(repoRoot) {
  const releaseLock = acquireLocalHeavyCheckLockSync({
    cwd: repoRoot,
    env: process.env,
    toolName: "extension-package-boundary-artifacts",
    lockName: "extension-package-boundary-artifacts",
  });
  let exitCode = 0;

  try {
    const result = spawnSync(
      process.execPath,
      [path.resolve(repoRoot, "scripts", "prepare-extension-package-boundary-artifacts.mjs")],
      {
        cwd: repoRoot,
        stdio: "inherit",
        env: process.env,
      },
    );

    if (result.error) {
      throw result.error;
    }

    exitCode = result.status ?? 1;
  } finally {
    releaseLock();
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
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

export function collectTrackedTypeScriptFiles(
  repoRoot,
  roots,
  { spawn = spawnSync, exists = (filePath) => fs.existsSync(path.join(repoRoot, filePath)) } = {},
) {
  if (roots.length === 0) {
    return [];
  }

  const result = spawn("git", ["ls-files", "-z", "--", ...roots], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32",
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed while collecting extension lint targets: ${result.stderr.trim()}`,
    );
  }

  return result.stdout
    .split("\0")
    .filter((filePath) => filePath.length > 0)
    .filter((filePath) => exists(filePath))
    .filter((filePath) => filePath.endsWith(".ts") || filePath.endsWith(".tsx"))
    .filter((filePath) => !hasPathSegment(filePath, "node_modules"))
    .toSorted((a, b) => a.localeCompare(b));
}

function hasPathSegment(filePath, segment) {
  return filePath.split("/").includes(segment);
}
