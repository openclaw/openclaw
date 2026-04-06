import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extensionChannelTestRoots } from "../vitest.channel-paths.mjs";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalOxlintPolicy,
} from "./lib/local-heavy-check-runtime.mjs";

const repoRoot = process.cwd();
const oxlintPath = path.resolve("node_modules", ".bin", "oxlint");
const releaseLock = acquireLocalHeavyCheckLockSync({
  cwd: repoRoot,
  env: process.env,
  toolName: "oxlint-extension-channels",
  lockName: "oxlint-extension-channels",
});

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-channel-oxlint-"));
const tempConfigPath = path.join(tempDir, "oxlint.json");

try {
  const channelFiles = extensionChannelTestRoots.flatMap((root) =>
    collectTypeScriptFiles(path.resolve(repoRoot, root)),
  );

  if (channelFiles.length === 0) {
    console.error("No extension channel files found.");
    process.exit(1);
  }

  writeTempOxlintConfig(tempConfigPath);

  const baseArgs = ["-c", tempConfigPath, ...process.argv.slice(2), ...channelFiles];
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

function writeTempOxlintConfig(configPath) {
  const config = JSON.parse(fs.readFileSync(path.resolve(repoRoot, ".oxlintrc.json"), "utf8"));

  delete config.$schema;

  if (Array.isArray(config.ignorePatterns)) {
    config.ignorePatterns = config.ignorePatterns.filter((pattern) => pattern !== "extensions/");
    if (config.ignorePatterns.length === 0) {
      delete config.ignorePatterns;
    }
  }

  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
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

    files.push(path.relative(repoRoot, entryPath).split(path.sep).join("/"));
  }

  return files;
}
