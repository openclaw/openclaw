// Synthetic historical-window startup workload; use a fresh root for each cold sample.
// Default settling includes memory-core's five-minute follow-up; 30 seconds isolates the initial pass.
// node --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-boot.ts --mode seed --root <internal-dir> --sessions 1000
// SQLMEASURE_OBSERVER=<frozen-observer.cjs> node --import ./scripts/tsx.mjs scripts/perf/session-lifecycle-boot.ts --mode run --root <internal-dir> --output <new-internal-dir>
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort, requestProbeStatus } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
} from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    root: { type: "string" },
    output: { type: "string" },
    sessions: { type: "string", default: "1000" },
    entry: { type: "string", default: "dist/entry.js" },
    "settle-seconds": { type: "string", default: "330" },
    "steady-seconds": { type: "string", default: "60" },
    profile: { type: "boolean", default: false },
  },
});
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const sessions = integer(values.sessions, "--sessions", 1);
const settleSeconds = integer(values["settle-seconds"], "--settle-seconds", 1);
const steadySeconds = integer(values["steady-seconds"], "--steady-seconds", 60);
if (![100, 1000, 3000].includes(sessions) || !["seed", "run"].includes(values.mode ?? "")) {
  throw new Error("Use --mode seed|run and --sessions 100|1000|3000");
}

// The workload only owns descendants of the campaign's internal scratch directory.
function internalPath(raw: string | undefined, label: string, existing: boolean): string {
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error(`${label} requires an absolute internal campaign path`);
  }
  const resolved = path.resolve(raw);
  const allowed = realpathSync(path.join(homedir(), ".cache", "dbasync-campaign"));
  const actual = existing
    ? realpathSync(resolved)
    : path.join(realpathSync(path.dirname(resolved)), path.basename(resolved));
  if (!actual.startsWith(`${allowed}${path.sep}`) || actual === allowed) {
    throw new Error(`${label} must remain inside the internal campaign directory`);
  }
  return actual;
}
const root = internalPath(values.root, "--root", values.mode === "run");
const configPath = path.join(root, "openclaw.json");
const markerPath = path.join(root, "session-lifecycle-fixture.json");
const fixtureFormat = "openclaw-session-lifecycle-boot-v1";
const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_PROFILE: "synthetic-session-lifecycle-boot",
    OPENCLAW_LAUNCHD_LABEL: "dev.openclaw.synthetic-session-lifecycle-boot",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-synthetic-session-lifecycle-boot",
    OPENCLAW_WINDOWS_TASK_NAME: "OpenClaw Synthetic Session Lifecycle Boot",
    OPENCLAW_SKIP_CHANNELS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    TMPDIR: path.join(root, "tmp"),
  },
});

if (values.mode === "seed") {
  mkdirSync(root, { mode: 0o700 });
  for (const directory of ["home", "state", "tmp", "workspace"]) {
    mkdirSync(path.join(root, directory));
  }
  const config = {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { entries: { main: { workspace: path.join(root, "workspace") } } },
    plugins: {
      enabled: true,
      allow: ["memory-core"],
      slots: { memory: "memory-core" },
      entries: { "memory-core": { enabled: true } },
    },
    logging: { file: path.join(root, "gateway-file.log") },
  } satisfies OpenClawConfig;
  writeFileSync(configPath, JSON.stringify(config));
  // Storage resolvers capture their environment on import; bind before loading them.
  process.env = env;
  const [agentDb, stateDb, { writeSessionEntry }, { appendTranscriptEventsInTransaction }] =
    await Promise.all([
      import("../../src/state/openclaw-agent-db.js"),
      import("../../src/state/openclaw-state-db.js"),
      import("../../src/config/sessions/session-accessor.sqlite-entry-store.js"),
      import("../../src/config/sessions/session-accessor.sqlite-transcript-store.js"),
    ]);
  const old = Date.now() - 30 * 86_400_000;
  try {
    const options = { agentId: "main", env };
    agentDb.runOpenClawAgentWriteTransaction((database) => {
      for (let index = 0; index < sessions; index++) {
        const sessionKey = `agent:main:synthetic-lifecycle-${index}`;
        // Rotation through the real entry owner leaves one unreferenced historical window.
        for (const generation of ["historical", "current"]) {
          const sessionId = `synthetic-lifecycle-${index}-${generation}`;
          writeSessionEntry(database, sessionKey, { sessionId, updatedAt: old });
          const timestamp = new Date(old).toISOString();
          const events: TranscriptEvent[] = [
            { type: "session", version: 3, id: sessionId, timestamp, runId: "synthetic-unrelated" },
            {
              type: "message",
              id: `${sessionId}-message`,
              parentId: null,
              timestamp,
              message: {
                role: "user",
                timestamp: old,
                content: [{ type: "text", text: "Synthetic unrelated historical transcript." }],
              },
            },
          ];
          const appended = appendTranscriptEventsInTransaction(
            database,
            { ...options, sessionKey, sessionId },
            events,
          );
          if (appended !== events.length) {
            throw new Error("Synthetic transcript seed was incomplete");
          }
        }
      }
    }, options);
  } finally {
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
  }
  const summary = { format: fixtureFormat, sessions, windows: sessions * 2, events: sessions * 4 };
  writeFileSync(markerPath, JSON.stringify(summary));
  console.log(JSON.stringify(summary));
} else {
  const fixture: unknown = JSON.parse(readFileSync(markerPath, "utf8"));
  if (!isRecord(fixture) || fixture.format !== fixtureFormat || fixture.sessions !== sessions) {
    throw new Error("Expected matching synthetic session-lifecycle fixture");
  }
  const observer = process.env.SQLMEASURE_OBSERVER;
  if (!observer || !path.isAbsolute(observer)) {
    throw new Error("SQLMEASURE_OBSERVER must name the original frozen observer.cjs");
  }
  const output = internalPath(values.output, "--output", false);
  mkdirSync(output, { mode: 0o700 });
  const phasePath = path.join(output, "phase");
  const phases: Array<{ phase: string; start: number; end: number }> = [];
  let phaseStartedAt = Date.now();
  let phaseName = "01.boot";
  writeFileSync(phasePath, phaseName);
  const changePhase = (next: string) => {
    const now = Date.now();
    phases.push({ phase: phaseName, start: phaseStartedAt, end: now });
    phaseStartedAt = now;
    phaseName = next;
    writeFileSync(phasePath, next);
  };
  const port = await getFreePort();
  const log = openSync(path.join(output, "gateway.log"), "wx");
  const loadBefore = loadavg();
  const started = performance.now();
  const gateway = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(
      path.resolve(values.entry),
      port,
      gatewayBenchCpuProfileArgs(values.profile ? path.join(output, "profiles") : undefined),
    ),
    {
      env: {
        ...env,
        SQLMEASURE_OUT: output,
        NODE_OPTIONS: `--require=${JSON.stringify(observer)}`,
      },
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Startup measurement interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  let readyMs: number | undefined;
  let teardown;
  const alive = () => {
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Owned Gateway exited; inspect synthetic gateway.log");
    }
  };
  try {
    while ((await requestProbeStatus(port, "/readyz")).status !== 200) {
      alive();
      if (performance.now() - started > 180_000) {
        throw new Error("Gateway readiness timed out");
      }
      await delay(50, undefined, { signal: abort.signal });
    }
    readyMs = performance.now() - started;
    changePhase("02.settle");
    await delay(settleSeconds * 1000, undefined, { signal: abort.signal });
    alive();
    changePhase("03.steady");
    await delay(steadySeconds * 1000, undefined, { signal: abort.signal });
    alive();
  } finally {
    changePhase("04.shutdown");
    teardown = await stopChild(gateway, { teardownGraceMs: 30_000 });
    changePhase("05.done");
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    const summary = {
      fixture,
      readyMs,
      settleSeconds,
      steadySeconds,
      phases,
      teardown,
      loadBefore,
      loadAfter: loadavg(),
    };
    writeFileSync(path.join(output, "result.json"), JSON.stringify(summary, null, 2));
    // Compatible with the frozen statement-counts.py Gateway/main-thread classification.
    writeFileSync(
      path.join(output, "evidence.json"),
      JSON.stringify({
        children: [{ name: "gateway", pid: gateway.pid }],
        turns: [],
        phases,
      }),
    );
    console.log(JSON.stringify(summary));
  }
  if (teardown.exitedBeforeTeardown || teardown.exitCode !== 0 || teardown.signal !== null) {
    throw new Error("Gateway did not shut down cleanly");
  }
}
