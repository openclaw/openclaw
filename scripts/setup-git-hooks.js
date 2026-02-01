import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_HOOKS_PATH = "git-hooks";
const PRE_COMMIT_HOOK = "pre-commit";

function getRepoRoot() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..");
}

function runGitCommand(args, options = {}) {
  return spawnSync("git", args, {
    cwd: options.cwd,
    encoding: "utf-8",
    stdio: options.stdio ?? "pipe",
  });
}

function ensureExecutable(targetPath) {
  if (process.platform === "win32") {
    return;
  }
  if (!fs.existsSync(targetPath)) {
    return;
  }
  try {
    const mode = fs.statSync(targetPath).mode & 0o777;
    if (mode & 0o100) {
      return;
    }
    fs.chmodSync(targetPath, 0o755);
  } catch (err) {
    console.warn(`[setup-git-hooks] chmod failed: ${err}`);
  }
}

function isGitAvailable({ repoRoot = getRepoRoot(), runGit = runGitCommand } = {}) {
  const result = runGit(["--version"], { cwd: repoRoot, stdio: "ignore" });
  return result.status === 0;
}

function isGitRepo({ repoRoot = getRepoRoot(), runGit = runGitCommand } = {}) {
  const result = runGit(["rev-parse", "--is-inside-work-tree"], {
    cwd: repoRoot,
    stdio: "pipe",
  });
  if (result.status !== 0) {
    return false;
  }
  return String(result.stdout ?? "").trim() === "true";
}

function setHooksPath({
  repoRoot = getRepoRoot(),
  hooksPath = DEFAULT_HOOKS_PATH,
  runGit = runGitCommand,
} = {}) {
  const result = runGit(["config", "core.hooksPath", hooksPath], {
    cwd: repoRoot,
    stdio: "ignore",
  });
  return result.status === 0;
}

function setupGitHooks({
  repoRoot = getRepoRoot(),
  hooksPath = DEFAULT_HOOKS_PATH,
  runGit = runGitCommand,
} = {}) {
  if (!isGitAvailable({ repoRoot, runGit })) {
    return { ok: false, reason: "git-missing" };
  }

  if (!isGitRepo({ repoRoot, runGit })) {
    return { ok: false, reason: "not-repo" };
  }

  if (!setHooksPath({ repoRoot, hooksPath, runGit })) {
    return { ok: false, reason: "config-failed" };
  }

  ensureExecutable(path.join(repoRoot, hooksPath, PRE_COMMIT_HOOK));

  return { ok: true };
}

export {
  DEFAULT_HOOKS_PATH,
  PRE_COMMIT_HOOK,
  ensureExecutable,
  getRepoRoot,
  isGitAvailable,
  isGitRepo,
  runGitCommand,
  setHooksPath,
  setupGitHooks,
};

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupGitHooks();
}
