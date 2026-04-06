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

  try {
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

function writeTempOxlintConfig(repoRoot, configPath) {
  const config = JSON.parse(fs.readFileSync(path.resolve(repoRoot, ".oxlintrc.json"), "utf8"));

  delete config.$schema;

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

    files.push(path.relative(process.cwd(), entryPath).split(path.sep).join("/"));
  }

  return files;
}
