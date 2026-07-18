#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses installed tools when present, otherwise falls back to pinned hooks where
// possible, then runs repo-specific workflow guards.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTIONLINT_VERSION = "1.7.12";
const PRE_COMMIT_VERSION = "4.2.0";
const WORKFLOW_DIR = ".github/workflows";
const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60_000;
const MAX_COMMAND_TIMEOUT_MS = 30 * 60_000;
const COMMAND_TIMEOUT_KILL_GRACE_MS = 1_000;
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

function killProcessTree(child, signal) {
  const killChild = () => {
    try {
      child.kill(signal);
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
  };
  if (process.platform === "win32") {
    killChild();
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") {
      killChild();
    }
  }
}

function spawnCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    // Node's sync timeout waits for SIGTERM handlers to exit. Run POSIX tools in
    // a process group so timeout escalation can terminate non-cooperative scans.
    const child = spawn(command, args, {
      ...options,
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timedOut = false;
    let killTimer;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => {
        killProcessTree(child, "SIGKILL");
      }, COMMAND_TIMEOUT_KILL_GRACE_MS);
    }, commandTimeoutMs);

    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      resolve({ error, status: null, timedOut });
    });

    child.on("exit", (status, signal) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      const error = timedOut
        ? Object.assign(new Error("Command timed out"), { code: "ETIMEDOUT" })
        : null;
      resolve({ error, signal, status, timedOut });
    });
  });
}

function commandFailureMessage(command, args, error) {
  if (error?.code === "ETIMEDOUT") {
    return `[check-workflows] timed out after ${commandTimeoutMs}ms: ${commandLabel(command, args)}`;
  }
  return `[check-workflows] failed to run ${command}: ${error?.message ?? "unknown error"}`;
}

async function commandExists(command, args = ["--version"]) {
  const result = await spawnCommand(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

async function run(command, args) {
  const result = await spawnCommand(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(commandFailureMessage(command, args, result.error));
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

async function runChecked(command, args) {
  const result = await spawnCommand(command, args, { stdio: "inherit" });
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
    const venvFailure = await runChecked("python3", ["-m", "venv", venvDir]);
    if (venvFailure) {
      return false;
    }
    postVenvFailure = await runChecked(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      `pre-commit==${PRE_COMMIT_VERSION}`,
    ]);
    if (postVenvFailure) {
      return false;
    }
    postVenvFailure = await runChecked(python, ["-m", "pre_commit", ...hookArgs]);
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
    await run("pre-commit", hookArgs);
    return;
  }
  if (await commandExists("python3", ["-m", "pre_commit", "--version"])) {
    await run("python3", ["-m", "pre_commit", ...hookArgs]);
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

const workflows = workflowFiles();

if (await commandExists("actionlint")) {
  await run("actionlint", workflows);
} else if (await commandExists("go", ["version"])) {
  await run("go", ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`]);
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
