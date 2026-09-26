#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses qualified installed tools, otherwise falls back to pinned hooks where
// possible, then runs repo-specific workflow guards.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ACTIONLINT_REVISION = "011a6d15e749bb3f2d771eed9c7aa0e7e3e10ee7";
const PRE_COMMIT_VERSION = "4.6.2";
// pre-commit 4.6.2 declares requires-python >=3.10, so an older interpreter only
// fails after a venv build and a network pip install.
const PRE_COMMIT_PYTHON_FLOOR = "3.10";
const WORKFLOW_DIR = ".github/workflows";

function commandExists(command: string, args: readonly string[] = ["--version"]): boolean {
  const result = spawnSync(command, args, { stdio: "ignore" });
  return !result.error && result.status === 0;
}

function hasPinnedActionlint(): boolean {
  const result = spawnSync("actionlint", ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return false;
  }
  // Released 1.7.12 can deadlock on Darwin. Only reuse the Go build of our CI
  // pin; release and unknown local builds do not establish that fix's presence.
  const version = result.stdout.split(/\r?\n/u, 1)[0]?.trim() ?? "";
  const revision = /^v\d+\.\d+\.\d+-\d+\.\d{14}-([a-f0-9]{12})$/u.exec(version)?.[1];
  if (revision === ACTIONLINT_REVISION.slice(0, 12)) {
    return true;
  }
  console.warn(
    `[check-workflows] installed actionlint does not match ${ACTIONLINT_REVISION}; using pinned fallback.`,
  );
  return false;
}

function probePythonVersion(
  command: string,
): { runnable: false } | { runnable: true; version?: string } {
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) {
    return { runnable: false };
  }
  const match = /Python (\d+\.\d+(?:\.\d+)?)/u.exec(`${result.stdout ?? ""}${result.stderr ?? ""}`);
  const version = match?.[1];
  return version ? { runnable: true, version } : { runnable: true };
}

function isBelowPythonFloor(version: string, floor: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map((part) => Number(part));
  const [floorMajor = 0, floorMinor = 0] = floor.split(".").map((part) => Number(part));
  return major < floorMajor || (major === floorMajor && minor < floorMinor);
}

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    console.error(`[check-workflows] failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function runChecked(command: string, args: readonly string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) {
    return {
      message: `[check-workflows] failed to run ${command}: ${result.error.message}`,
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

function exitWithFailure(failure: NonNullable<ReturnType<typeof runChecked>>): never {
  if (failure.message) {
    console.error(failure.message);
  }
  process.exit(failure.status);
}

function runGoActionlint(files: string[]): boolean {
  if (!commandExists("go", ["version"])) {
    return false;
  }
  const binDir = mkdtempSync(join(tmpdir(), "openclaw-check-workflows-actionlint-"));
  let lintFailure: ReturnType<typeof runChecked> = null;
  try {
    const installed = spawnSync(
      "go",
      ["install", `github.com/rhysd/actionlint/cmd/actionlint@${ACTIONLINT_REVISION}`],
      { stdio: "inherit", env: { ...process.env, GOBIN: binDir } },
    );
    // An unavailable pin can still use a cached hook. Lint diagnostics must stay
    // terminal, so acquisition and execution cannot share a go run exit status.
    if (installed.error || installed.status !== 0) {
      return false;
    }
    lintFailure = runChecked(
      join(binDir, process.platform === "win32" ? "actionlint.exe" : "actionlint"),
      files,
    );
  } finally {
    rmSync(binDir, { force: true, recursive: true });
  }
  if (lintFailure) {
    exitWithFailure(lintFailure);
  }
  return true;
}

function runPreCommitFromTempVenv(hookArgs: string[]): boolean {
  const pythonProbe = probePythonVersion("python3");
  if (!pythonProbe.runnable) {
    return false;
  }
  if (pythonProbe.version && isBelowPythonFloor(pythonProbe.version, PRE_COMMIT_PYTHON_FLOOR)) {
    console.error(
      `[check-workflows] python3 is ${pythonProbe.version}, but pre-commit ${PRE_COMMIT_VERSION} requires Python >=${PRE_COMMIT_PYTHON_FLOOR}. Install a newer python3 or a pre-commit runtime.`,
    );
    process.exit(1);
  }
  const venvDir = mkdtempSync(join(tmpdir(), "openclaw-check-workflows-pre-commit-"));
  const python = join(venvDir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  let postVenvFailure: ReturnType<typeof runChecked> = null;
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

function workflowFiles(): string[] {
  return readdirSync(WORKFLOW_DIR)
    .filter((file) => file.endsWith(".yml") || file.endsWith(".yaml"))
    .toSorted()
    .map((file) => join(WORKFLOW_DIR, file));
}

function runPreCommitHook(hook: string, files: string[]): void {
  const hookArgs = ["run", "--config", ".pre-commit-config.yaml", hook, "--files", ...files];
  if (commandExists("pre-commit")) {
    run("pre-commit", hookArgs);
    return;
  }
  if (commandExists("python3", ["-m", "pre_commit", "--version"])) {
    run("python3", ["-m", "pre_commit", ...hookArgs]);
    return;
  }
  if (runPreCommitFromTempVenv(hookArgs)) {
    return;
  }

  console.error(
    `[check-workflows] missing pre-commit runtime for ${hook}: install pre-commit or Python venv support for pre-commit ${PRE_COMMIT_VERSION}.`,
  );
  process.exit(1);
}

const workflows = workflowFiles();

if (hasPinnedActionlint()) {
  run("actionlint", workflows);
} else if (!runGoActionlint(workflows)) {
  if (
    commandExists("pre-commit") ||
    commandExists("python3", ["-m", "pre_commit", "--version"]) ||
    commandExists("python3", ["--version"])
  ) {
    runPreCommitHook("actionlint", workflows);
  } else {
    console.error(
      `[check-workflows] missing workflow linter: install actionlint built from ${ACTIONLINT_REVISION}, Go to acquire that revision, or a pre-commit runtime.`,
    );
    process.exit(1);
  }
}

runPreCommitHook("zizmor", workflows);

run("node", ["scripts/generate-ci-git-owner.mts", "--check"]);
run("python3", ["scripts/check-composite-action-input-interpolation.py"]);
run("node", ["scripts/check-no-conflict-markers.mjs"]);
