#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses installed tools when present, otherwise falls back to pinned hooks where
// possible, then runs repo-specific workflow guards.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTIONLINT_VERSION = "1.7.11";
const PRE_COMMIT_VERSION = "4.2.0";
const WORKFLOW_DIR = ".github/workflows";
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_ENV = "OPENCLAW_CHECK_WORKFLOWS_COMMAND_TIMEOUT_MS";

function resolveCommandTimeoutMs() {
  const raw = process.env[COMMAND_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    return DEFAULT_COMMAND_TIMEOUT_MS;
  }
  return Math.min(parsed, MAX_COMMAND_TIMEOUT_MS);
}

const commandTimeoutMs = resolveCommandTimeoutMs();

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

function spawnCommand(command, args, options = {}) {
  return spawnSync(command, args, {
    ...options,
    timeout: commandTimeoutMs,
  });
}

function commandFailureMessage(command, args, error) {
  if (error?.code === "ETIMEDOUT") {
    return `[check-workflows] timed out after ${commandTimeoutMs}ms: ${commandLabel(command, args)}`;
  }
  return `[check-workflows] failed to run ${command}: ${error?.message ?? "unknown error"}`;
}

function commandExists(command, args = ["--version"]) {
  const result = spawnCommand(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function run(command, args) {
  const result = spawnCommand(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(commandFailureMessage(command, args, result.error));
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runChecked(command, args) {
  const result = spawnCommand(command, args, { stdio: "inherit" });
  if (result.error) {
    return {
      message: commandFailureMessage(command, args, result.error),
      status: 1,
    };
  }
  if (result.status !== 0) {
    return {
      message: null,
      status: result.status ?? 1,
    };
  }
  return null;
}

function exitWithFailure(failure) {
  if (failure.message) {
    console.error(failure.message);
  }
  process.exit(failure.status);
}

function runPreCommitFromTempVenv(hook, hookArgs) {
  if (!commandExists("python3", ["--version"])) {
    return false;
  }
  const venvDir = mkdtempSync(join(tmpdir(), "openclaw-check-workflows-pre-commit-"));
  const python = join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let postVenvFailure;
  try {
    const venvFailure = runChecked("python3", ["-m", "venv", venvDir]);
    if (venvFailure) {
      return false;
    }
    postVenvFailure = runChecked(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      `pre-commit==${PRE_COMMIT_VERSION}`,
    ]);
    if (postVenvFailure) {
      return false;
    }
    postVenvFailure = runChecked(python, ["-m", "pre_commit", ...hookArgs]);
    if (postVenvFailure) {
      return false;
    }
    return true;
  } finally {
    rmSync(venvDir, { force: true, recursive: true });
    if (postVenvFailure) {
      exitWithFailure(postVenvFailure);
    }
  }
}

function workflowFiles() {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted()
    .map((file) => join(WORKFLOW_DIR, file));
}

function runPreCommitHook(hook, files) {
  const hookArgs = ["run", "--config", ".pre-commit-config.yaml", hook, "--files", ...files];
  if (commandExists("pre-commit")) {
    run("pre-commit", hookArgs);
    return;
  }
  if (commandExists("python3", ["-m", "pre_commit", "--version"])) {
    run("python3", ["-m", "pre_commit", ...hookArgs]);
    return;
  }
  if (runPreCommitFromTempVenv(hook, hookArgs)) {
    return;
  }

  console.error(
    `[check-workflows] missing pre-commit runtime for ${hook}: install pre-commit or Python venv support for pre-commit ${PRE_COMMIT_VERSION}.`,
  );
  process.exit(1);
}

const workflows = workflowFiles();

if (commandExists("actionlint")) {
  run("actionlint", workflows);
} else if (commandExists("go", ["version"])) {
  run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`]);
} else if (
  commandExists("pre-commit") ||
  commandExists("python3", ["-m", "pre_commit", "--version"]) ||
  commandExists("python3", ["--version"])
) {
  runPreCommitHook("actionlint", workflows);
} else {
  console.error(
    `[check-workflows] missing workflow linter: install actionlint, Go ${ACTIONLINT_VERSION} fallback support, or pre-commit.`,
  );
  process.exit(1);
}

runPreCommitHook("zizmor", workflows);

run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
run("node", ["scripts/check-no-conflict-markers.mjs"]);
