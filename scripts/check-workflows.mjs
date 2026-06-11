#!/usr/bin/env node
// Runs local workflow sanity checks.
// Uses an installed actionlint when present, otherwise falls back to `go run`
// for the pinned version used by CI, then runs repo-specific composite guards.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ACTIONLINT_VERSION = "1.7.11";

function commandExists(command, spawn) {
  return spawn("bash", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function run(command, args, spawn) {
  const result = spawn(command, args, { stdio: "inherit" });
  return result.status ?? 1;
}

export function runWorkflowChecks({ spawn = spawnSync, stderr = process.stderr } = {}) {
  if (commandExists("actionlint", spawn)) {
    const status = run("actionlint", [], spawn);
    if (status !== 0) {
      return status;
    }
  } else if (commandExists("go", spawn)) {
    const status = run(
      "go",
      ["run", `github.com/rhysd/actionlint/cmd/actionlint@v${ACTIONLINT_VERSION}`],
      spawn,
    );
    if (status !== 0) {
      return status;
    }
  } else {
    stderr.write(
      "Missing workflow linter dependency: install actionlint or Go so `pnpm check:workflows` can run actionlint.\n",
    );
    return 127;
  }

  for (const [command, args] of [
    ["python3", ["scripts/check-composite-action-input-interpolation.py"]],
    ["node", ["scripts/check-no-conflict-markers.mjs"]],
  ]) {
    const status = run(command, args, spawn);
    if (status !== 0) {
      return status;
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = runWorkflowChecks();
}
