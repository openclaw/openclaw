// Warm history-prewarm owner cost on an existing offline synthetic fixture:
// node --import ./scripts/tsx.mjs scripts/perf/session-history-prewarm-measure.mjs \
//   --state-dir .local/team-shape [--source-file .local/baseline-prewarm.ts] [--iterations 3000]
// Each iteration calls the real Gateway prewarm owner once with history already warm.
// This measures redundant owner work, not boot frequency, recovery latency, or RSS savings.
// Run separate processes in alternating order; no forced GC or allocation profiler.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    "source-file": { type: "string" },
    iterations: { type: "string", default: "3000" },
  },
});
assert(values["state-dir"], "--state-dir is required");
const root = path.resolve(values["state-dir"]);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
assert.equal(fixture.format, "openclaw-team-shape-v1", "Never pass live state");
const iterations = Number(values.iterations);
assert(
  Number.isSafeInteger(iterations) && iterations > 0,
  "--iterations must be a positive integer",
);
const configPath = path.join(root, "openclaw.json");
const home = path.join(root, "home");
const tmp = path.join(root, "tmp");
mkdirSync(home, { recursive: true });
mkdirSync(tmp, { recursive: true });
process.env = {
  ...createGatewayBenchEnv(home, configPath, { startupTrace: false }),
  OPENCLAW_STATE_DIR: root,
  USERPROFILE: home,
  TMPDIR: tmp,
  TMP: tmp,
  TEMP: tmp,
};
const config = JSON.parse(readFileSync(configPath, "utf8"));
const ownerUrl = new URL("../../src/gateway/server-history-prewarm.ts", import.meta.url);
const source = readFileSync(
  values["source-file"] ? path.resolve(values["source-file"]) : ownerUrl,
  "utf8",
);
let replaced = false;
if (values["source-file"]) {
  registerHooks({
    load(url, context, nextLoad) {
      if (url === ownerUrl.href) {
        replaced = true;
        return { format: "module-typescript", source, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
const { prewarmGatewaySessionHistory } = await import(ownerUrl.href);
const { isSessionHistoryWorkerCold } =
  await import("../../src/config/sessions/session-transcript-worker-runtime.js");
const { closeOpenClawAgentDatabasesAsync } = await import("../../src/state/openclaw-agent-db.js");
const { closeOpenClawStateDatabaseAsync } = await import("../../src/state/openclaw-state-db.js");
try {
  assert(!values["source-file"] || replaced, "Frozen owner was not loaded");
  await prewarmGatewaySessionHistory(config);
  assert(!isSessionHistoryWorkerCold(), "The real history worker must be warm before measurement");
  const hostLoadBefore = loadavg();
  const allocatedBefore = getHeapStatistics().total_allocated_bytes;
  assert(Number.isFinite(allocatedBefore), "Node must expose total_allocated_bytes");
  const cpuBefore = process.threadCpuUsage();
  const started = performance.now();
  for (let index = 0; index < iterations; index++) {
    await prewarmGatewaySessionHistory(config);
  }
  const wallMs = performance.now() - started;
  const cpu = process.threadCpuUsage(cpuBefore);
  const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedBefore;
  console.log(
    JSON.stringify({
      iterations,
      sourceSha256: createHash("sha256").update(source).digest("hex"),
      fixtureSessions: fixture.sessionCount,
      wallMs,
      mainThreadCpuMicros: cpu.user + cpu.system,
      allocatedBytes,
      cpuMicrosPerCall: (cpu.user + cpu.system) / iterations,
      allocatedBytesPerCall: allocatedBytes / iterations,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
    }),
  );
} finally {
  try {
    await closeOpenClawAgentDatabasesAsync();
  } finally {
    await closeOpenClawStateDatabaseAsync();
  }
}
