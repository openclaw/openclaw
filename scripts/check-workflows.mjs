#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses installed tools when present, otherwise falls back to pinned hooks where
// possible, then runs repo-specific workflow guards.
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runManagedCommand } from "./lib/managed-child-process.mjs";

const ACTIONLINT_VERSION = "1.7.12";
const PRE_COMMIT_VERSION = "4.2.0";
const WORKFLOW_DIR = ".github/workflows";
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
// Dependency bootstrap (Go module fetch, temporary-venv pip install, and
// pre-commit hook-environment setup) is network- and disk-bound and can
// legitimately exceed the linter budget on a slow network. Keep it bounded to
// prevent indefinite hangs, but with its own longer budget so healthy slow
// downloads are not treated as stalled scans.
const BOOTSTRAP_COMMAND_TIMEOUT_MS = 15 * 60_000;

function commandLabel(command, args) {
  return [command, ...args].join(" ");
}

async function spawnCommand(command, args, options = {}) {
  // Delegate the timeout, process-tree teardown, Windows shell normalization,
  // and validated System32 taskkill resolution to the repository's canonical
  // managed child-process runner.
  const { timeoutMs = DEFAULT_COMMAND_TIMEOUT_MS, stdio = "inherit" } = options;
  try {
    const status = await runManagedCommand({ bin: command, args, stdio, timeoutMs });
    return { error: null, signal: null, status, timedOut: false, timeoutMs };
  } catch (error) {
    if (error?.code === "ETIMEDOUT") {
      error.timeoutMs = timeoutMs;
    }
    return {
      error,
      signal: null,
      status: null,
      timedOut: error?.code === "ETIMEDOUT",
      timeoutMs,
    };
  }
}

async function main() {
  const workflows = workflowFiles();

  if (await commandExists("actionlint")) {
    await run("actionlint", workflows);
  } else if (await commandExists("go", ["version"])) {
    await run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
  } else if (
    (await commandExists("pre-commit")) ||
    (await commandExists("python3", ["-m", "pre_commit", "--version"])) ||
    (await commandExists("python3", ["--version"]))
  ) {
    await runPreCommitHook("actionlint", workflows);
  } else {
    console.error(
      `[check-workflows] missing workflow linter: install actionlint, Go ${ACTIONLINT_VERSION} fallback support, or pre-commit.`,
    );
    process.exit(1);
  }

  await runPreCommitHook("zizmor", workflows);

  await run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
  await run("node", ["scripts/check-no-conflict-markers.mjs"]);
}

function commandFailureMessage(command, args, error) {
  if (error?.code === "ETIMEDOUT") {
    return `[check-workflows] timed out after ${error.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS}ms: ${commandLabel(command, args)}`;
  }
  return `[check-workflows] failed to run ${command}: ${error?.message ?? "unknown error"}`;
}

async function commandExists(command, args = ["--version"]) {
  const result = await spawnCommand(command, args, { stdio: "ignore" });
  if (result.error) {
    if (result.error.code === "ENOENT") {
      return false;
    }
    console.error(commandFailureMessage(command, args, result.error));
    process.exit(1);
  }
  return !result.error && result.status === 0;
}

async function run(command, args, options = {}) {
  const result = await spawnCommand(command, args, { stdio: "inherit", ...options });
  if (result.error) {
    console.error(commandFailureMessage(command, args, result.error));
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function runChecked(command, args, options = {}) {
  const result = await spawnCommand(command, args, { stdio: "inherit", ...options });
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

async function runPreCommitFromTempVenv(hook, hookArgs) {
  if (!(await commandExists("python3", ["--version"]))) {
    return false;
  }
  const venvDir = mkdtempSync(join(tmpdir(), "openclaw-check-workflows-pre-commit-"));
  const python = join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let postVenvFailure;
  try {
    const venvFailure = await runChecked("python3", ["-m", "venv", venvDir], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
    if (venvFailure) {
      // Preserve spawn/timeout diagnostics from the bounded venv bootstrap
      // instead of falling back to the generic missing-runtime message.
      // Ordinary nonzero venv exits keep the existing fallback behavior.
      if (venvFailure.message) {
        postVenvFailure = venvFailure;
      }
      return false;
    }
    postVenvFailure = await runChecked(
      python,
      ["-m", "pip", "install", "--disable-pip-version-check", `pre-commit==${PRE_COMMIT_VERSION}`],
      { timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS },
    );
    if (postVenvFailure) {
      return false;
    }
    postVenvFailure = await runChecked(python, ["-m", "pre_commit", ...hookArgs], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
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

async function runPreCommitHook(hook, files) {
  const hookArgs = ["run", "--config", ".pre-commit-config.yaml", hook, "--files", ...files];
  if (await commandExists("pre-commit")) {
    await run("pre-commit", hookArgs, { timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS });
    return;
  }
  if (await commandExists("python3", ["-m", "pre_commit", "--version"])) {
    await run("python3", ["-m", "pre_commit", ...hookArgs], {
      timeoutMs: BOOTSTRAP_COMMAND_TIMEOUT_MS,
    });
    return;
  }
  if (await runPreCommitFromTempVenv(hook, hookArgs)) {
    return;
  }

  console.error(
    `[check-workflows] missing pre-commit runtime for ${hook}: install pre-commit or Python venv support for pre-commit ${PRE_COMMIT_VERSION}.`,
  );
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  await main();
}
