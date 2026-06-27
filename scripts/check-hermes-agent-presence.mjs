import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const OFFICIAL_HERMES_REMOTE = "https://github.com/NousResearch/hermes-agent.git";

export function normalizeHermesRemoteUrl(value) {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  return trimmed.endsWith(".git") ? trimmed : `${trimmed}.git`;
}

export function isOfficialHermesRemote(value) {
  return normalizeHermesRemoteUrl(value) === OFFICIAL_HERMES_REMOTE;
}

export function normalizeHermesMode(value) {
  const mode = typeof value === "string" && value.trim() ? value.trim() : "mock";
  return mode === "mock" || mode === "real" ? mode : undefined;
}

function runGit(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function formatDetailValue(value) {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function fail(message, details = {}) {
  console.error(`Hermes Agent presence check failed: ${message}`);
  for (const [key, value] of Object.entries(details)) {
    if (value) {
      console.error(`${key}: ${formatDetailValue(value)}`);
    }
  }
  process.exitCode = 1;
}

export function checkHermesAgentPresence(env = process.env, cwd = process.cwd()) {
  const configuredPath = env.HERMES_AGENT_PATH?.trim() || "../hermes-agent";
  const hermesMode = normalizeHermesMode(env.HERMES_MODE);
  if (!hermesMode) {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath: path.resolve(cwd, configuredPath),
      error: "invalid_hermes_mode",
      message: "HERMES_MODE must be either mock or real.",
    };
  }
  const resolvedPath = path.resolve(cwd, configuredPath);
  if (!fs.existsSync(resolvedPath)) {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath,
      error: "path_missing",
      message: "HERMES_AGENT_PATH does not exist.",
    };
  }
  if (!fs.statSync(resolvedPath).isDirectory()) {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath,
      error: "path_not_directory",
      message: "HERMES_AGENT_PATH is not a directory.",
    };
  }

  const insideGit = runGit(["rev-parse", "--is-inside-work-tree"], resolvedPath);
  if (insideGit.status !== 0 || insideGit.stdout !== "true") {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath,
      error: "not_git_repo",
      message: "HERMES_AGENT_PATH is not a git worktree.",
      stderr: insideGit.stderr,
    };
  }

  const remote = runGit(["remote", "get-url", "origin"], resolvedPath);
  if (remote.status !== 0) {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath,
      error: "remote_unavailable",
      message: "Unable to read Hermes origin remote.",
      stderr: remote.stderr,
    };
  }
  if (!isOfficialHermesRemote(remote.stdout)) {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath,
      remote: remote.stdout,
      error: "remote_mismatch",
      message: "Hermes origin remote is not the official NousResearch/hermes-agent repo.",
    };
  }

  const commit = runGit(["rev-parse", "HEAD"], resolvedPath);
  if (commit.status !== 0) {
    return {
      ok: false,
      path: configuredPath,
      resolvedPath,
      remote: remote.stdout,
      error: "head_unavailable",
      message: "Unable to read Hermes HEAD commit.",
      stderr: commit.stderr,
    };
  }

  return {
    ok: true,
    path: configuredPath,
    resolvedPath,
    remote: normalizeHermesRemoteUrl(remote.stdout),
    commit: commit.stdout,
    hermesMode,
  };
}

function main() {
  const result = checkHermesAgentPresence();
  if (!result.ok) {
    fail(result.message, {
      path: result.path,
      resolvedPath: result.resolvedPath,
      remote: result.remote,
      stderr: result.stderr,
      error: result.error,
    });
    return;
  }
  console.log("Hermes Agent presence check OK");
  console.log(`path: ${result.path}`);
  console.log(`resolvedPath: ${result.resolvedPath}`);
  console.log(`remote: ${result.remote}`);
  console.log(`commit: ${result.commit}`);
  console.log(`hermesMode: ${result.hermesMode}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
