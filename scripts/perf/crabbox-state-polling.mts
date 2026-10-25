// Synthetic Crabbox maintenance through the real Gateway; no provider operations.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
  resolveEntry,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    out: { type: "string" },
    observer: { type: "string" },
    entry: { type: "string" },
    profile: { type: "boolean", default: false },
  },
});
if (!values.out || !values.observer) {
  throw new Error("--out and --observer are required");
}
const output = path.resolve(values.out);
const observer = path.resolve(values.observer);
const repo = fileURLToPath(new URL("../../", import.meta.url));
mkdirSync(output); // Fresh state for every run; refuse to mix evidence.
const fixture = path.join(output, "fixture");
const sql = path.join(output, "sql");
const tmp = path.join(output, "tmp");
for (const directory of [fixture, sql, tmp, path.join(fixture, "workspace")]) {
  mkdirSync(directory, { recursive: true });
}
const callsPath = path.join(output, "crabbox-calls.txt");
writeFileSync(callsPath, "");
const binary = path.join(fixture, "synthetic-crabbox");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
writeFileSync(
  binary,
  `#!/bin/sh
if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  printf '%s\\n' version >> ${quote(callsPath)}
  printf '%s\\n' 'crabbox version 0.79.2'
  exit 0
fi
printf '%s\\n' unexpected >> ${quote(callsPath)}
printf '%s\\n' 'Unexpected synthetic Crabbox command' >&2
exit 97
`,
  { mode: 0o755 },
);
const configPath = writeGatewayBenchConfig(
  fixture,
  {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { defaults: { skipBootstrap: true } },
    cron: { enabled: false },
    logging: { file: path.join(output, "gateway-file.log") },
    plugins: { enabled: true, allow: ["crabbox"], entries: { crabbox: { enabled: true } } },
    cloudWorkers: {
      preparedPool: { maxTotal: 0 },
      profiles: {
        synthetic: {
          provider: "crabbox",
          readyWorkers: 0,
          settings: {
            provider: "synthetic",
            ttl: "1h",
            idleTimeout: "10m",
            warmImage: false,
            binary,
          },
        },
      },
    },
  },
  { agentList: [{ id: "main", workspace: path.join(fixture, "workspace") }] },
);
const env = createGatewayBenchEnv(fixture, configPath, {
  startupTrace: false,
  caseEnv: {
    NODE_DISABLE_COMPILE_CACHE: "1",
    TMPDIR: tmp,
    SQLMEASURE_OUT: sql,
    NODE_OPTIONS: `--require=${JSON.stringify(observer)} --enable-source-maps`,
  },
});
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Crabbox measurement interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
let child: ChildProcess | undefined;
let phase = "boot";
let phaseStart = Date.now();
const evidence = {
  format: "openclaw-crabbox-state-polling-v1",
  workload: { settleSeconds: 70, steadySeconds: 120, profiles: 1, readyWorkers: 0 },
  phases: [] as Array<{ phase: string; start: number; end: number }>,
  ready: false,
  crabboxCalls: { version: 0, unexpected: 0 },
  shutdown: null as Awaited<ReturnType<typeof stopChild>> | null,
  error: null as string | null,
  ok: false,
};
writeFileSync(path.join(sql, "phase"), phase);
function setPhase(next: string) {
  const now = Date.now();
  evidence.phases.push({ phase, start: phaseStart, end: now });
  phase = next;
  phaseStart = now;
  writeFileSync(path.join(sql, "phase"), phase);
}
try {
  const port = await getFreePort();
  const log = openSync(path.join(output, "gateway.log"), "wx");
  try {
    child = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(
        resolveEntry(values.entry, "dist/entry.js"),
        port,
        gatewayBenchCpuProfileArgs(values.profile ? path.join(output, "cpu") : undefined),
      ),
      { cwd: repo, env, detached: true, stdio: ["ignore", log, log] },
    );
  } finally {
    closeSync(log);
  }
  const gateway = child;
  gateway.once("error", (error) => abort.abort(error));
  gateway.once("exit", (code, signal) =>
    abort.abort(new Error(`Gateway exited: code=${code} signal=${signal}`)),
  );
  const started = performance.now();
  const readiness = await waitForInitialProbe({
    port,
    path: "/healthz",
    startAt: started,
    deadlineAt: started + 300_000,
    isDone: () => abort.signal.aborted,
  });
  assert.equal(readiness.status, 200, "Gateway readiness failed; see gateway.log");
  evidence.ready = true;
  await delay(70_000, undefined, { signal: abort.signal });
  setPhase("steady");
  await delay(120_000, undefined, { signal: abort.signal });
} catch (error) {
  evidence.error = error instanceof Error ? error.message : String(error);
} finally {
  setPhase("shutdown");
  try {
    if (child) {
      evidence.shutdown = await stopChild(child, { teardownGraceMs: 30_000, killGraceMs: 2_000 });
    }
  } catch (error) {
    evidence.error ??= error instanceof Error ? error.message : String(error);
  }
  const calls = readFileSync(callsPath, "utf8").split("\n");
  evidence.crabboxCalls = {
    version: calls.filter((call) => call === "version").length,
    unexpected: calls.filter((call) => call !== "version" && call !== "").length,
  };
  evidence.ok =
    evidence.error === null &&
    evidence.crabboxCalls.version > 0 &&
    evidence.crabboxCalls.unexpected === 0 &&
    evidence.shutdown?.exitCode === 0 &&
    evidence.shutdown.signal === null;
  evidence.phases.push({ phase, start: phaseStart, end: Date.now() });
  writeFileSync(path.join(output, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
assert(evidence.ok, evidence.error ?? "Invalid maintenance run or shutdown; see evidence.json");
console.log(JSON.stringify({ output, ok: evidence.ok, crabboxCalls: evidence.crabboxCalls }));
