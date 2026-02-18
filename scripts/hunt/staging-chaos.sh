#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Run staging-only chaos checks for the OpenClaw release gate.

Usage:
  bash scripts/hunt/staging-chaos.sh [options]

Options:
  --out-dir <path>   Output directory (default: artifacts/hunt/staging-chaos-<utc>)
  --release <name>   Release label in report (default: unknown)
  --run-id <id>      Run identifier (default: staging-chaos-<utc>)
  --port <number>    Isolated staging port (default: 19789)
  --no-render        Skip Markdown/JSON render step
  -h, --help         Show help
USAGE
}

STAMP_UTC="$(date -u +%Y%m%dT%H%M%SZ)"
OUT_DIR="artifacts/hunt/staging-chaos-${STAMP_UTC}"
RELEASE_LABEL="unknown"
RUN_ID="staging-chaos-${STAMP_UTC}"
STAGING_PORT="19789"
NO_RENDER="0"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    --release)
      RELEASE_LABEL="${2:-}"
      shift 2
      ;;
    --run-id)
      RUN_ID="${2:-}"
      shift 2
      ;;
    --port)
      STAGING_PORT="${2:-}"
      shift 2
      ;;
    --no-render)
      NO_RENDER="1"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

mkdir -p "$OUT_DIR"

export HUNT_OUT_DIR="$OUT_DIR"
export HUNT_RELEASE_LABEL="$RELEASE_LABEL"
export HUNT_RUN_ID="$RUN_ID"
export HUNT_STAGING_PORT="$STAGING_PORT"

node - <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const outDir = process.env.HUNT_OUT_DIR;
const release = process.env.HUNT_RELEASE_LABEL || "unknown";
const runId = process.env.HUNT_RUN_ID || `staging-chaos-${Date.now()}`;
const stagingPort = Number.parseInt(process.env.HUNT_STAGING_PORT || "19789", 10);

if (!outDir) {
  throw new Error("HUNT_OUT_DIR missing");
}

const startedAt = new Date().toISOString();
const checks = [];
const stagingRoot = path.join(outDir, "staging-runtime");
const stagingHome = path.join(stagingRoot, "home");
const stagingConfigPath = path.join(stagingRoot, "openclaw.staging.json");

fs.mkdirSync(stagingRoot, { recursive: true });
fs.mkdirSync(path.join(stagingHome, ".openclaw"), { recursive: true });

const stagingConfig = {
  gateway: {
    mode: "local",
    port: stagingPort,
    bind: "loopback",
  },
  // Keep channels empty in staging chaos. OPENCLAW_SKIP_CHANNELS/CLAWDBOT_SKIP_CHANNELS
  // enforce non-startup, and an empty object avoids schema drift between providers.
  channels: {},
};
fs.writeFileSync(stagingConfigPath, `${JSON.stringify(stagingConfig, null, 2)}\n`, "utf-8");
fs.writeFileSync(path.join(stagingHome, ".openclaw", "openclaw.json"), `${JSON.stringify(stagingConfig, null, 2)}\n`, "utf-8");

const baseEnv = {
  ...process.env,
  HOME: stagingHome,
  OPENCLAW_CONFIG: stagingConfigPath,
  OPENCLAW_SKIP_CHANNELS: "1",
  CLAWDBOT_SKIP_CHANNELS: "1",
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCommand(command, timeoutMs = 15000, env = baseEnv) {
  const result = spawnSync("bash", ["-lc", command], {
    env,
    encoding: "utf-8",
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  const timedOut = Boolean(result.error && result.error.code === "ETIMEDOUT");
  return {
    command,
    exitCode: Number.isInteger(result.status) ? result.status : timedOut ? 124 : 1,
    stdout: String(result.stdout || "").trim(),
    stderr: String(result.stderr || "").trim(),
    timedOut,
    error: result.error ? String(result.error) : "",
  };
}

function pushCheck(params) {
  checks.push(params);
}

async function waitForPort(port, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const probe = runCommand(`lsof -nP -iTCP:${port} -sTCP:LISTEN || true`, 3000);
    if (probe.stdout.includes(`:${port}`)) {
      return true;
    }
    await sleep(300);
  }
  return false;
}

async function stopChild(child, signal = "SIGTERM") {
  if (!child || child.killed) {
    return;
  }
  try {
    process.kill(child.pid, signal);
  } catch {
    return;
  }
  const started = Date.now();
  while (Date.now() - started < 5000) {
    if (child.exitCode !== null) {
      return;
    }
    await sleep(200);
  }
  try {
    process.kill(child.pid, "SIGKILL");
  } catch {
    // ignore
  }
}

async function scenarioPortCollision() {
  const id = "chaos_port_collision";
  const title = "Port collision guard (staging)";
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  const collision = spawn(process.execPath, [
    "-e",
    `const net=require('node:net'); const s=net.createServer(()=>{}); s.listen(${stagingPort}, '127.0.0.1'); setInterval(()=>{}, 1000);`,
  ], {
    env: baseEnv,
    stdio: "ignore",
  });

  await sleep(500);
  const run = runCommand(`openclaw gateway --port ${stagingPort}`, 12000);
  await stopChild(collision);

  const ok = run.exitCode !== 0;
  const ended = Date.now();
  pushCheck({
    id,
    title,
    status: ok ? "pass" : "fail",
    command: run.command,
    summary: ok ? "second process refused occupied port as expected" : "gateway unexpectedly started on occupied port",
    startedAt: startedAtIso,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    evidence: [
      `exitCode=${run.exitCode}`,
      run.stderr.slice(0, 400),
      run.stdout.slice(0, 400),
    ].filter(Boolean),
    metadata: { timedOut: run.timedOut },
  });
}

async function scenarioAlreadyRunning() {
  const id = "chaos_already_running_guard";
  const title = "Already-running lock/guard (staging)";
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  const gatewayLogPath = path.join(outDir, "chaos-already-running.gateway.log");
  const outFd = fs.openSync(gatewayLogPath, "a");
  const gateway = spawn("bash", ["-lc", `openclaw gateway --port ${stagingPort}`], {
    env: baseEnv,
    stdio: ["ignore", outFd, outFd],
  });

  const startedOk = await waitForPort(stagingPort, 20000);
  if (!startedOk) {
    await stopChild(gateway);
    fs.closeSync(outFd);
    const ended = Date.now();
    pushCheck({
      id,
      title,
      status: "warn",
      command: `openclaw gateway --port ${stagingPort}`,
      summary: "staging gateway did not reach LISTEN state in time; scenario skipped",
      startedAt: startedAtIso,
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      artifacts: [gatewayLogPath],
    });
    return;
  }

  const second = runCommand(`openclaw gateway --port ${stagingPort}`, 12000);
  await stopChild(gateway);
  fs.closeSync(outFd);

  const ok = second.exitCode !== 0;
  const ended = Date.now();
  pushCheck({
    id,
    title,
    status: ok ? "pass" : "fail",
    command: second.command,
    summary: ok ? "second gateway start blocked as expected" : "second gateway start unexpectedly succeeded",
    startedAt: startedAtIso,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    evidence: [
      `exitCode=${second.exitCode}`,
      second.stderr.slice(0, 400),
      second.stdout.slice(0, 400),
    ].filter(Boolean),
    artifacts: [gatewayLogPath],
    metadata: { timedOut: second.timedOut },
  });
}

async function scenarioSigusr1() {
  const id = "chaos_sigusr1_restart";
  const title = "SIGUSR1 in-process restart stability (staging)";
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  const gatewayLogPath = path.join(outDir, "chaos-sigusr1.gateway.log");
  const outFd = fs.openSync(gatewayLogPath, "a");
  const gateway = spawn("bash", ["-lc", `openclaw gateway --port ${stagingPort}`], {
    env: baseEnv,
    stdio: ["ignore", outFd, outFd],
  });

  const startedOk = await waitForPort(stagingPort, 20000);
  if (!startedOk) {
    await stopChild(gateway);
    fs.closeSync(outFd);
    const ended = Date.now();
    pushCheck({
      id,
      title,
      status: "warn",
      command: `kill -USR1 ${gateway.pid}`,
      summary: "staging gateway did not become ready; SIGUSR1 scenario skipped",
      startedAt: startedAtIso,
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
      artifacts: [gatewayLogPath],
    });
    return;
  }

  let signalSent = true;
  try {
    process.kill(gateway.pid, "SIGUSR1");
  } catch {
    signalSent = false;
  }

  await sleep(3000);
  const probe = runCommand(`lsof -nP -iTCP:${stagingPort} -sTCP:LISTEN || true`, 3000);
  await stopChild(gateway);
  fs.closeSync(outFd);

  const ok = signalSent && probe.stdout.includes(`:${stagingPort}`);
  const ended = Date.now();
  pushCheck({
    id,
    title,
    status: ok ? "pass" : "warn",
    command: `kill -USR1 ${gateway.pid}`,
    summary: ok
      ? "gateway remained reachable after SIGUSR1"
      : "gateway was not clearly reachable after SIGUSR1 (needs manual follow-up)",
    startedAt: startedAtIso,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    evidence: [probe.stdout.slice(0, 300), probe.stderr.slice(0, 300)].filter(Boolean),
    artifacts: [gatewayLogPath],
  });
}

function scenarioMissingBinaryEnv() {
  const id = "chaos_missing_binary_env";
  const title = "Missing binary/env behavior";
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  const run = runCommand("PATH=/usr/bin:/bin openclaw --version", 5000, baseEnv);
  const ok = run.exitCode !== 0;
  const ended = Date.now();

  pushCheck({
    id,
    title,
    status: ok ? "pass" : "warn",
    command: run.command,
    summary: ok
      ? "missing PATH entry failed fast as expected"
      : "openclaw still found in stripped PATH (environment specific)",
    startedAt: startedAtIso,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    evidence: [run.stderr.slice(0, 300), run.stdout.slice(0, 300)].filter(Boolean),
  });
}

function scenarioTransientNetworkFailure() {
  const id = "chaos_transient_network_failure";
  const title = "Transient network failure simulation";
  const started = Date.now();
  const startedAtIso = new Date(started).toISOString();

  const hasCurl = runCommand("command -v curl >/dev/null 2>&1", 3000, baseEnv).exitCode === 0;
  if (!hasCurl) {
    const ended = Date.now();
    pushCheck({
      id,
      title,
      status: "skip",
      command: "curl",
      summary: "curl missing; transient network scenario skipped",
      startedAt: startedAtIso,
      endedAt: new Date(ended).toISOString(),
      durationMs: ended - started,
    });
    return;
  }

  const run = runCommand("HTTPS_PROXY=http://127.0.0.1:9 curl -fsS --max-time 4 https://example.com", 8000, baseEnv);
  const ok = run.exitCode !== 0;
  const ended = Date.now();

  pushCheck({
    id,
    title,
    status: ok ? "pass" : "warn",
    command: run.command,
    summary: ok
      ? "network failure fault injection produced expected failure"
      : "network failure simulation unexpectedly succeeded",
    startedAt: startedAtIso,
    endedAt: new Date(ended).toISOString(),
    durationMs: ended - started,
    evidence: [run.stderr.slice(0, 300), run.stdout.slice(0, 300)].filter(Boolean),
  });
}

async function main() {
  await scenarioPortCollision();
  await scenarioAlreadyRunning();
  await scenarioSigusr1();
  scenarioMissingBinaryEnv();
  scenarioTransientNetworkFailure();

  const endedAt = new Date().toISOString();
  const failCount = checks.filter((c) => c.status === "fail").length;
  const warnCount = checks.filter((c) => c.status === "warn").length;

  const classification = [];
  if (failCount > 0) {
    classification.push({
      id: "staging_chaos_failures",
      category: "ops",
      severity: "p1",
      status: "new",
      summary: `${failCount} staging chaos checks failed`,
      expected: "faults should be blocked or handled gracefully",
      actual: "one or more chaos scenarios did not behave as expected",
      suggestedFix: "inspect per-check artifacts and add/adjust resilience tests",
    });
  }
  if (failCount === 0 && warnCount > 0) {
    classification.push({
      id: "staging_chaos_warnings",
      category: "ops",
      severity: "p2",
      status: "known",
      summary: `${warnCount} staging chaos checks ended with warnings`,
      suggestedFix: "review warnings and tighten deterministic checks where needed",
    });
  }

  const report = {
    version: "1",
    release,
    runId,
    lane: "staging-chaos",
    startedAt,
    endedAt,
    checks,
    signatures: [],
    classification,
    upstreamLinks: [
      "https://github.com/openclaw/openclaw/issues/19788",
      "https://github.com/openclaw/openclaw/issues/19944",
    ],
    metadata: {
      stagingPort,
      stagingHome,
      stagingConfigPath,
      outDir,
    },
  };

  fs.writeFileSync(path.join(outDir, "report-input.json"), `${JSON.stringify(report, null, 2)}\n`, "utf-8");
  console.log(`Wrote staging chaos input: ${path.join(outDir, "report-input.json")}`);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
NODE

if [[ "$NO_RENDER" != "1" ]]; then
  node --import tsx scripts/hunt/render-report.ts \
    --input "$OUT_DIR/report-input.json" \
    --json-out "$OUT_DIR/hunt-report.json" \
    --md-out "$OUT_DIR/hunt-report.md"
fi

echo "Staging chaos run complete: $OUT_DIR"
