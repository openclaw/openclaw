// Generate state with team-shape-fixture.ts, then clone it at the same path before each arm.
// node --import ./scripts/tsx.mjs scripts/perf/doctor-transcript-heap-measure.mts \
//   --state-dir <synthetic-fixture> --entry <built-dist/entry.js> --output <fresh-directory>
// The caller owns serial A/A and A/B sampling, stopped fixture copies, and cleanup.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    entry: { type: "string" },
    output: { type: "string" },
    profile: { type: "boolean", default: false },
  },
});
assert.ok(values["state-dir"] && values.entry && values.output);
const state = fs.realpathSync(values["state-dir"]);
const entry = fs.realpathSync(values.entry);
const output = path.resolve(values.output);
assert.notEqual(state, path.join(os.homedir(), ".openclaw"), "Only synthetic fixtures are allowed");
const fixture = JSON.parse(fs.readFileSync(path.join(state, "team-shape-summary.json"), "utf8"));
assert.ok(
  fixture.format === "openclaw-team-shape-v1" &&
    fixture.sessionCount > 0 &&
    fixture.agentDatabaseBytes > 0,
  "Expected team-shape fixture",
);
fs.mkdirSync(output, { recursive: false });
const probe = fileURLToPath(new URL("./doctor-transcript-heap-probe.cjs", import.meta.url));
const config = path.join(state, "openclaw.json");
const env = {
  ...createGatewayBenchEnv(path.join(state, "home"), config, { startupTrace: false }),
  OPENCLAW_STATE_DIR: state,
  TMPDIR: path.join(state, "tmp"),
  OPENCLAW_SUPERVISOR_MODE: "external",
  OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  OPENCLAW_BENCH_DOCTOR_HEAP_OUTPUT: output,
  NODE_OPTIONS: `--require=${JSON.stringify(probe)}`,
};
fs.mkdirSync(env.TMPDIR, { recursive: true });
const args = [
  ...(values.profile ? ["--cpu-prof", "--cpu-prof-interval=1000", `--cpu-prof-dir=${output}`] : []),
  entry,
  "doctor",
  "--fix",
  "--non-interactive",
];
const before = { time: Date.now(), load: os.loadavg() };
fs.writeFileSync(
  path.join(output, "command.json"),
  JSON.stringify({ entry, args, fixture, before }, null, 2),
);
const log = fs.openSync(path.join(output, "doctor.log"), "wx", 0o600);
const child = spawn(process.execPath, args, { env, stdio: ["ignore", log, log] });
const [code, signal] = await once(child, "close");
fs.closeSync(log);
const after = { time: Date.now(), load: os.loadavg() };
const processes = [];
for (const file of fs.readdirSync(output).filter((name) => /^heap-\d+-\d+\.jsonl$/.test(name))) {
  const records = fs
    .readFileSync(path.join(output, file), "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const queries = [];
  const starts = new Map();
  const definitions = new Map();
  for (const record of records) {
    if (record.kind === "query-prepared") {
      definitions.set(record.id, record);
    }
    if (record.kind === "query-start") {
      starts.set(record.id, record);
    }
    if (record.kind === "query-end" && starts.has(record.id)) {
      const start = starts.get(record.id);
      const definition = definitions.get(record.id);
      queries.push({
        id: record.id,
        sql: definition.sql,
        stack: definition.stack,
        method: record.method,
        rows: record.rows,
        udfCalls: record.calls - start.calls,
        elapsedMs: record.elapsedMs - start.elapsedMs,
        cpuMs:
          (record.threadCpu.user +
            record.threadCpu.system -
            start.threadCpu.user -
            start.threadCpu.system) /
          1000,
        allocatedBytes: record.allocatedBytes - start.allocatedBytes,
        heapBefore: start.heapUsed,
        heapAfter: record.heapUsed,
      });
      starts.delete(record.id);
    }
  }
  const first = records[0];
  const last = records.at(-1);
  processes.push({
    file,
    pid: first.pid,
    threadId: first.threadId,
    heapLimit: first.heapLimit,
    peakHeap: records.reduce((peak, row) => Math.max(peak, row.peakHeap), 0),
    peakExternal: records.reduce((peak, row) => Math.max(peak, row.peakExternal), 0),
    allocatedBytes: last.allocatedBytes - first.allocatedBytes,
    cpuMs:
      (last.threadCpu.user +
        last.threadCpu.system -
        first.threadCpu.user -
        first.threadCpu.system) /
      1000,
    completed: last.kind === "exit",
    queries,
  });
}
const result = { code, signal, elapsedMs: after.time - before.time, before, after, processes };
fs.writeFileSync(path.join(output, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
process.exitCode = code ?? 1;
