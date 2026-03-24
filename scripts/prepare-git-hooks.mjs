#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import process from "node:process";
import { pathToFileURL } from "node:url";

function runGit(args, options = {}) {
  try {
    return spawnSync("git", args, {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: options.stdio ?? ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32",
    });
  } catch {
    return null;
  }
}

export function main() {
  const insideWorkTree = runGit(["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree || insideWorkTree.status !== 0) {
    return 0;
  }

  const configureHooks = runGit(["config", "core.hooksPath", "git-hooks"], {
    stdio: "inherit",
  });
  if (!configureHooks) {
    return 0;
  }
  return configureHooks.status ?? 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exit(main());
}
