#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

function runGit(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function findRepoRoot(cwd) {
  try {
    return runGit(["rev-parse", "--show-toplevel"], cwd);
  } catch {
    return null;
  }
}

function readCurrentHooksPath(repoRoot) {
  try {
    return runGit(["config", "--local", "--get", "core.hooksPath"], repoRoot);
  } catch {
    return "";
  }
}

function prepareGitHooks(cwd = process.cwd()) {
  const repoRoot = findRepoRoot(cwd);
  if (!repoRoot) {
    console.log("[prepare-git-hooks] skipped: not inside a git worktree");
    return;
  }

  const hooksDir = path.join(repoRoot, "git-hooks");
  const preCommitHook = path.join(hooksDir, "pre-commit");
  if (!existsSync(preCommitHook)) {
    console.log("[prepare-git-hooks] skipped: git-hooks/pre-commit is missing");
    return;
  }

  if (readCurrentHooksPath(repoRoot) === "git-hooks") {
    console.log("[prepare-git-hooks] core.hooksPath=git-hooks");
    return;
  }

  try {
    runGit(["config", "--local", "core.hooksPath", "git-hooks"], repoRoot);
    console.log("[prepare-git-hooks] core.hooksPath=git-hooks");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[prepare-git-hooks] warning: could not set core.hooksPath: ${message}`);
  }
}

prepareGitHooks();
