/**
 * Synthetic post-run owner benchmark; no agent database or workspace reads.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/cron-terminal-outcome-measure.ts \
 *   [--revision <base>] [--profile <file>] > measurement.json
 * Alternate five base/candidate pairs plus A/A. Acceptance: all watchdog outcomes
 * retain timeout classification; report CPU/allocation cost without a speedup claim.
 * 10,000 distinct sessions model the resident terminal population. Transcript
 * bytes and workspace files are outside this owner's read set, not simulated I/O.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks } from "node:module";
import { loadavg } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { getHeapStatistics } from "node:v8";

const { values } = parseArgs({
  options: {
    revision: { type: "string" },
    profile: { type: "string" },
  },
});
assert(global.gc, "Run with --expose-gc");
const owners = ["src/auto-reply/reply/session-event-terminal.ts", "src/agents/run-termination.ts"];
if (values.revision) {
  const sources = new Map(
    owners.map((file) => [
      pathToFileURL(path.resolve(file)).href,
      execFileSync("git", ["show", `${values.revision}:${file}`], { encoding: "utf8" }),
    ]),
  );
  registerHooks({
    load(url, context, next) {
      const source = sources.get(url);
      return source === undefined
        ? next(url, context)
        : { source, format: "module-typescript", shortCircuit: true };
    },
  });
}
const { resolveSessionEventTerminalOutcome } =
  await import("../../src/auto-reply/reply/session-event-terminal.js");
const fixtures: Parameters<typeof resolveSessionEventTerminalOutcome>[0][] = Array.from(
  { length: 10_000 },
  (_, i) => ({
    operation: {
      result: { kind: "failed", code: "run_stalled" },
      abortSignal: AbortSignal.abort(new Error(`Synthetic watchdog ${i}`)),
    },
    signal: new AbortController().signal,
    failure: "Session event execution aborted",
  }),
);
let timeouts = 0;
function run() {
  for (const fixture of fixtures) {
    if (resolveSessionEventTerminalOutcome(fixture).terminalOutcome.status === "timeout") {
      timeouts++;
    }
  }
}
for (let i = 0; i < 5; i++) {
  run();
}
timeouts = 0;
global.gc();
const inspector = new Session();
if (values.profile) {
  inspector.connect();
  await inspector.post("Profiler.enable");
  await inspector.post("Profiler.start");
}
const allocatedStart = getHeapStatistics().total_allocated_bytes;
const cpu = process.threadCpuUsage();
const start = performance.now();
for (let i = 0; i < 20; i++) {
  run();
}
const wallMs = performance.now() - start;
const used = process.threadCpuUsage(cpu);
const allocatedBytes = getHeapStatistics().total_allocated_bytes - allocatedStart;
if (values.profile) {
  writeFileSync(values.profile, JSON.stringify((await inspector.post("Profiler.stop")).profile));
  inspector.disconnect();
}
console.log(
  JSON.stringify({
    revision: values.revision ?? "candidate",
    sessions: fixtures.length,
    outcomes: 200_000,
    timeouts,
    wallMs,
    cpuMs: (used.user + used.system) / 1000,
    allocatedBytes,
    load: loadavg(),
  }),
);
