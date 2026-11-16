// One readiness sample against an already-built Gateway and an offline synthetic fixture.
// node scripts/perf/prepared-gateway-startup-measure.mjs --state-dir <team-shape-fixture>
//   --port 41551 --output <json> [--entry dist/entry.js] [--timeout-ms 600000]
// Restore the same prepared fixture between samples; alternate base/candidate builds
// at the same entry path. Collect at least five per side and report host load and spread.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    port: { type: "string" },
    output: { type: "string" },
    "timeout-ms": { type: "string", default: "600000" },
  },
});
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const state = fs.realpathSync(values["state-dir"]);
const fixture = JSON.parse(fs.readFileSync(path.join(state, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1");
const port = Number(values.port);
const timeoutMs = Number(values["timeout-ms"]);
assert(Number.isSafeInteger(port) && port >= 40000 && port <= 65535);
assert(Number.isSafeInteger(timeoutMs) && timeoutMs > 0);
const portProbe = createServer().listen(port, "127.0.0.1");
await once(portProbe, "listening");
await portProbe[Symbol.asyncDispose]();
const logPath = `${values.output}.log`;
const log = fs.openSync(logPath, "w");
const hostLoadBefore = loadavg();
const start = performance.now();
const child = spawn(
  process.execPath,
  [
    path.resolve(values.entry),
    "gateway",
    "run",
    "--allow-unconfigured",
    "--port",
    String(port),
    "--bind",
    "loopback",
  ],
  {
    env: {
      PATH: process.env.PATH,
      HOME: `${state}/home`,
      TMPDIR: `${state}/tmp`,
      CI: "1",
      NO_COLOR: "1",
      OPENCLAW_HOME: `${state}/home`,
      OPENCLAW_STATE_DIR: state,
      OPENCLAW_CONFIG_PATH: `${state}/openclaw.json`,
      OPENCLAW_PROFILE: fixture.profile,
      OPENCLAW_NO_RESPAWN: "1",
      OPENCLAW_EXEC_SHELL_SNAPSHOT: "0",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_GATEWAY_STARTUP_TRACE: "1",
      OPENCLAW_DISABLE_BONJOUR: "1",
    },
    stdio: ["ignore", log, log],
  },
);
const exited = once(child, "exit");
let readyMs;
try {
  while (performance.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(`Gateway exited ${child.exitCode}; see ${logPath}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        readyMs = performance.now() - start;
        break;
      }
    } catch {}
    await delay(50);
  }
  assert(readyMs, `Gateway did not become ready; see ${logPath}`);
  const output = fs.readFileSync(logPath, "utf8");
  const modelRuntime = /startup trace: sidecars\.model-runtime ([\d.]+)ms/.exec(output);
  assert(modelRuntime, `Missing child model-startup trace; see ${logPath}`);
  const result = {
    readyMs,
    modelRuntimeMs: Number(modelRuntime[1]),
    sessionCount: fixture.sessionCount,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
  };
  fs.writeFileSync(values.output, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  const forced = setTimeout(() => {
    if (child.exitCode === null) {
      child.kill("SIGKILL");
    }
  }, 45000);
  try {
    await exited;
  } finally {
    clearTimeout(forced);
    fs.closeSync(log);
  }
}
