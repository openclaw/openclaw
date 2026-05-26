#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/check-cli-surface.sh [--host | --image IMAGE] [--baseline PATH] [--output-dir DIR]

Options:
  --host           Run commands on the host PATH. This is the default.
  --image IMAGE    Run commands inside IMAGE with docker run.
  --baseline PATH  Previous current.json/baseline JSON to diff against.
  --output-dir DIR Directory for current.json, summary.md, diff.txt, failures.txt.
  -h, --help       Show this help.
EOF
}

MODE="host"
IMAGE=""
BASELINE=""
OUTPUT_DIR=".artifacts/cli-surface"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      MODE="host"
      IMAGE=""
      shift
      ;;
    --image)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --image requires a value" >&2
        exit 2
      fi
      MODE="docker"
      IMAGE="$2"
      shift 2
      ;;
    --baseline)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --baseline requires a value" >&2
        exit 2
      fi
      BASELINE="$2"
      shift 2
      ;;
    --output-dir)
      if [ "$#" -lt 2 ]; then
        echo "ERROR: --output-dir requires a value" >&2
        exit 2
      fi
      OUTPUT_DIR="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$MODE" = "docker" ] && [ -z "$IMAGE" ]; then
  echo "ERROR: --image requires an image reference" >&2
  exit 2
fi

mkdir -p "$OUTPUT_DIR/raw"

run_surface_command() {
  local command="$1"
  if [ "$MODE" = "docker" ]; then
    docker run --rm --entrypoint /bin/bash "$IMAGE" -lc "$command"
  else
    bash -lc "$command"
  fi
}

write_command_result() {
  local id="$1"
  local command="$2"
  local expect="$3"
  local contains="$4"
  local stdout_file="$OUTPUT_DIR/raw/$id.stdout"
  local stderr_file="$OUTPUT_DIR/raw/$id.stderr"
  local status_file="$OUTPUT_DIR/raw/$id.status"

  set +e
  run_surface_command "$command" >"$stdout_file" 2>"$stderr_file"
  local status=$?
  set -e

  printf '%s\n' "$status" >"$status_file"
  printf '%s\t%s\t%s\t%s\n' "$id" "$command" "$expect" "$contains" >>"$OUTPUT_DIR/raw/commands.tsv"
}

: >"$OUTPUT_DIR/raw/commands.tsv"
write_command_result "claude-version" "claude --version" "version" ""
write_command_result "claude-auth-login-help" "claude auth login --help" "contains" "--claudeai"
write_command_result "claude-setup-token-help" "claude setup-token --help" "exit0" ""
write_command_result "codex-version" "codex --version" "nonempty" ""
write_command_result "codex-device-auth-help" "codex login --device-auth --help" "exit0" ""

node - "$OUTPUT_DIR" "${BASELINE:-}" "$MODE" "${IMAGE:-}" <<'NODE'
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const [outputDir, baselinePath, mode, image] = process.argv.slice(2);
const rawDir = path.join(outputDir, "raw");
const commandsPath = path.join(rawDir, "commands.tsv");

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function normalize(value) {
  return value
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, "").replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function unifiedDiff(label, previous, current) {
  const tmp = fs.mkdtempSync(path.join(outputDir, ".diff-"));
  const previousPath = path.join(tmp, "previous.txt");
  const currentPath = path.join(tmp, "current.txt");
  fs.writeFileSync(previousPath, previous ? `${previous}\n` : "", "utf8");
  fs.writeFileSync(currentPath, current ? `${current}\n` : "", "utf8");
  const result = spawnSync(
    "diff",
    ["-u", "--label", `${label} previous`, "--label", `${label} current`, previousPath, currentPath],
    { encoding: "utf8" },
  );
  fs.rmSync(tmp, { force: true, recursive: true });
  return result.stdout || result.stderr || "";
}

const rows = read(commandsPath)
  .split("\n")
  .filter(Boolean)
  .map((line) => {
    const [id, command, expect, contains] = line.split("\t");
    const stdout = read(path.join(rawDir, `${id}.stdout`));
    const stderr = read(path.join(rawDir, `${id}.stderr`));
    const combined = stdout.trim() ? stdout : `${stdout}${stderr}`;
    const normalized = normalize(combined);
    const exitCode = Number(read(path.join(rawDir, `${id}.status`)).trim());
    const assertions = [];
    if (exitCode !== 0) {
      assertions.push(`expected exit 0, got ${exitCode}`);
    }
    if (expect === "nonempty" && normalized.length === 0) {
      assertions.push("expected a non-empty version string");
    }
    if (expect === "version" && !/[0-9]+(\.[0-9]+)?/.test(normalized)) {
      assertions.push("expected output to contain a version token");
    }
    if (expect === "contains" && !normalized.includes(contains)) {
      assertions.push(`expected normalized output to contain ${contains}`);
    }
    return {
      id,
      command,
      expect,
      contains: contains || null,
      exitCode,
      ok: assertions.length === 0,
      assertions,
      output: normalized,
    };
  });

let previous = null;
if (baselinePath && fs.existsSync(baselinePath)) {
  try {
    previous = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
  } catch (error) {
    previous = { commands: [], baselineError: String(error && error.message ? error.message : error) };
  }
}

const previousById = new Map((previous?.commands || []).map((entry) => [entry.id, entry]));
const drift = [];
const diffParts = [];
for (const row of rows) {
  const prior = previousById.get(row.id);
  if (!prior) {
    continue;
  }
  const priorOutput = normalize(String(prior.output || ""));
  if (priorOutput !== row.output) {
    drift.push({ id: row.id, command: row.command });
    diffParts.push(unifiedDiff(row.command, priorOutput, row.output));
  }
}

const failures = rows.filter((row) => !row.ok);
const failedRun = failures.length > 0 || drift.length > 0;
const result = {
  schemaVersion: 1,
  checkedAt: new Date().toISOString(),
  runner: mode === "docker" ? { mode, image } : { mode },
  ok: !failedRun,
  failureCount: failures.length,
  driftCount: drift.length,
  commands: rows,
  drift,
};

fs.writeFileSync(path.join(outputDir, "current.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
fs.writeFileSync(path.join(outputDir, "diff.txt"), diffParts.join("\n"), "utf8");
fs.writeFileSync(
  path.join(outputDir, "failures.txt"),
  failures
    .map((row) => `${row.command}\n${row.assertions.map((assertion) => `- ${assertion}`).join("\n")}`)
    .join("\n\n"),
  "utf8",
);

const statusIcon = failedRun ? "❌" : "✅";
const subject = mode === "docker" ? `multitenant image \`${image}\`` : "host CLI tools";
const headline =
  failures.length > 0
    ? `${failures.length} CLI surface assertion(s) failed`
    : drift.length > 0
      ? `${drift.length} CLI surface command(s) drifted`
      : "All 5 CLI surface assertions hold";
const lines = [
  `## CLI Surface Smoke`,
  "",
  `${statusIcon} ${headline} against ${subject}.`,
  "",
  `| Command | Exit | Assertion | Drift |`,
  `| --- | ---: | --- | --- |`,
];
for (const row of rows) {
  const drifted = drift.some((entry) => entry.id === row.id);
  const assertion = row.ok ? "ok" : row.assertions.join("; ");
  lines.push(`| \`${row.command}\` | ${row.exitCode} | ${assertion.replace(/\|/g, "\\|")} | ${drifted ? "changed" : "unchanged"} |`);
}
if (!previous) {
  lines.push("", "No prior baseline was available; this run establishes one.");
} else if (drift.length > 0) {
  lines.push("", `Meaningful normalized output drift detected for ${drift.length} command(s).`);
} else {
  lines.push("", "No meaningful normalized output drift vs prior baseline.");
}
if (failures.length > 0) {
  lines.push("", "### Failed commands");
  for (const row of failures) {
    lines.push("", `- \`${row.command}\`: ${row.assertions.join("; ")}`);
  }
}
fs.writeFileSync(path.join(outputDir, "summary.md"), `${lines.join("\n")}\n`, "utf8");

if (failures.length > 0 || drift.length > 0) {
  process.exit(1);
}
NODE
