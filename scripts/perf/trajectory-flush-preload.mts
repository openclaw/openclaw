/**
 * Synthetic built-Gateway timing only. Add to transcript-broadcast-measure.ts:
 * --scenario memory-soak --stress-tools --stress-subagents --diagnostics
 * --gateway-preload scripts/perf/trajectory-flush-preload.mts
 * Run identical untraced instrumentation on both arms. On normal Gateway exit,
 * writes <OPENCLAW_STATE_DIR>/trajectory-flush-measurement.json (must not exist).
 * Require valid=true, then join samples[].streamStart.subagent.childRunId to
 * records[].runId. Keep every matching invocation, distinguish hasRecorder=false,
 * and report missing joins; an absent record is never zero flush cost. Filter
 * by the measured child run IDs to exclude warmup/shutdown activity.
 * This times the existing cleanup helper, including its timeout/admission wait;
 * it does not time the whole subagent or instrument background threshold flushes.
 * No payloads or arguments are collected. Forced SIGKILL produces no artifact.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMainThread } from "node:worker_threads";

const expectedBody = `async function flushEmbeddedAttemptTrajectoryRecorder(params) {
\tawait runAgentCleanupStep({
\t\t...params,
\t\tstep: "openclaw-trajectory-flush",
\t\tgetTimeoutDetails: () => params.trajectoryRecorder?.describeFlushState(),
\t\tcleanup: async () => {
\t\t\tawait params.trajectoryRecorder?.flush();
\t\t}
\t});
}`;
const sourceMarker = "//#region src/agents/embedded-agent-runner/run/attempt-trajectory-flush.ts";
type FlushRecord = {
  runId: string;
  sessionId: string;
  startedAtEpochMs: number;
  durationMs: number;
  hasRecorder: boolean;
};
const records: FlushRecord[] = [];
let failure: string | undefined;
const targets: Array<{ path: string; sha256: string }> = [];

/** The built helper calls this synchronously from its existing async frame. */
export function recordTrajectoryFlush(
  runId: string,
  sessionId: string,
  startedAtEpochMs: number,
  durationMs: number,
  hasRecorder: boolean,
) {
  if (records.length >= 50_000) {
    failure ??= "Trajectory flush observation exceeded 50000 records";
    return;
  }
  if (typeof runId !== "string" || typeof sessionId !== "string") {
    failure ??= "Trajectory flush identifiers were not strings";
    return;
  }
  records.push({ runId, sessionId, startedAtEpochMs, durationMs, hasRecorder });
}

/** Exact checked transformation used by the loader hook below. */
function instrumentTrajectoryFlushSource(source: string): string {
  assert(source.includes(sourceMarker), "Trajectory flush source marker changed");
  assert.equal(source.split(expectedBody).length, 2, "Trajectory flush built body changed");
  const originalStatements = expectedBody.slice(expectedBody.indexOf("\n") + 1, -2);
  return `import { recordTrajectoryFlush as __recordTrajectoryFlush } from ${JSON.stringify(import.meta.url)};
${source.replace(
  expectedBody,
  `async function flushEmbeddedAttemptTrajectoryRecorder(params) {
  const __trajectoryStarted = performance.now();
  const __trajectoryEpoch = Date.now();
  const __trajectoryHasRecorder = Boolean(params.trajectoryRecorder);
  try {
${originalStatements}
  } finally {
    __recordTrajectoryFlush(params.runId, params.sessionId, __trajectoryEpoch,
      performance.now() - __trajectoryStarted, __trajectoryHasRecorder);
  }
}`,
)}`;
}

if (isMainThread) {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  assert(stateDir && path.isAbsolute(stateDir), "Requires an explicit synthetic state directory");
  assert(typeof process.send === "function", "Requires the benchmark Gateway IPC channel");
  assert.equal(
    process.env.HOME,
    path.join(stateDir, "home"),
    "Requires the synthetic fixture HOME",
  );
  const port = Number(process.env.OPENCLAW_PROFILE?.match(/^team-shape-(\d+)$/u)?.[1]);
  assert(port >= 40000 && port <= 65535, "Requires a high-port team-shape benchmark profile");
  const fixture = JSON.parse(readFileSync(path.join(stateDir, "team-shape-summary.json"), "utf8"));
  assert.equal(fixture.format, "openclaw-team-shape-v1", "Requires generated synthetic state");
  const entry = path.resolve(process.argv[1] ?? "");
  const distDir = path.dirname(entry);
  assert.equal(path.basename(distDir), "dist", "Requires a compiled-dist Gateway entry");
  const output = path.join(stateDir, "trajectory-flush-measurement.json");
  assert(!existsSync(output), "Refusing to overwrite an earlier trajectory flush measurement");

  registerHooks({
    load(url, context, nextLoad) {
      const loaded = nextLoad(url, context);
      if (!url.startsWith("file:")) {
        return loaded;
      }
      const filename = fileURLToPath(url);
      if (
        path.dirname(filename) !== distDir ||
        !/^attempt-trajectory-flush-[\w-]+\.mjs$/u.test(path.basename(filename))
      ) {
        return loaded;
      }
      try {
        assert.equal(targets.length, 0, "Multiple trajectory flush targets loaded");
        assert(loaded.source != null, "Trajectory flush module source was unavailable");
        const source =
          typeof loaded.source === "string"
            ? loaded.source
            : new TextDecoder().decode(loaded.source);
        const instrumented = instrumentTrajectoryFlushSource(source);
        targets.push({ path: filename, sha256: createHash("sha256").update(source).digest("hex") });
        return { ...loaded, source: instrumented };
      } catch (error) {
        failure ??=
          error instanceof Error ? error.message : "Trajectory flush instrumentation failed";
        throw error;
      }
    },
  });
  process.once("exit", () => {
    if (targets.length !== 1) {
      failure ??= "Expected one instrumented trajectory flush target";
    }
    if (records.length === 0) {
      failure ??= "No completed trajectory flush invocations observed";
    }
    const valid = failure === undefined;
    if (!valid) {
      process.exitCode = 1;
    }
    writeFileSync(
      output,
      JSON.stringify({
        format: "openclaw-trajectory-flush-measurement-v1",
        valid,
        failure,
        instrumentedCount: targets.length,
        targets,
        completedFlushCount: records.length,
        records,
      }),
      { flag: "wx" },
    );
  });
}
