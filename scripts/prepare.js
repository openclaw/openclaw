#!/usr/bin/env node
/**
 * Cross-platform prepare script for npm lifecycle hook.
 * Sets up git hooks path if in a git repository.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

function isGitAvailable() {
  try {
    // Use git --version which works cross-platform
    execSync("git --version", {
      stdio: "ignore",
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

function isInsideGitWorkTree() {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      stdio: "ignore",
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

function setupGitHooks() {
  try {
    const hooksPath = "git-hooks";
    if (existsSync(hooksPath)) {
      execSync(`git config core.hooksPath "${hooksPath}"`, {
        stdio: "ignore",
        encoding: "utf8",
      });
      return true;
    }
  } catch {
    // Ignore errors
  }
  return false;
}

// Main execution
if (isGitAvailable() && isInsideGitWorkTree()) {
  setupGitHooks();
}
// Exit silently (this is a prepare hook, should not fail the install)
