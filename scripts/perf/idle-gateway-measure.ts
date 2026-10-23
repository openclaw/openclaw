// One real connected client, no application traffic after connect.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { readProcessTreeCpuMs } from "../lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuProfile,
  readGatewayCpuUsage,
  readGatewayGcTrace,
  readGatewayHeapProfile,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    minutes: { type: "string", default: "10" },
    "settle-seconds": { type: "string", default: "60" },
    "start-at": { type: "string" },
    port: { type: "string", default: "41563" },
    timers: { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
  },
});
if (!values.output) {
  throw new Error("--output is required (fresh artifact directory)");
}
if (values.profile && values.allocations) {
  throw new Error("Run CPU and allocation profiling separately to exclude profiler teardown");
}
const output = path.resolve(values.output);
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const minutes = integer(values.minutes, "--minutes", 1);
const settleSeconds = integer(values["settle-seconds"], "--settle-seconds", 0);
const port = integer(values.port, "--port", 40000);
const startAt = values["start-at"] ? integer(values["start-at"], "--start-at", 1) : undefined;
if (port > 65535) {
  throw new Error("Port exceeds 65535");
}
const channel = `idle-measure-${randomUUID()}`;
const state = values["state-dir"] ? path.resolve(values["state-dir"]) : undefined;
let fixture: Record<string, unknown> | undefined;
if (state) {
  const summary: unknown = JSON.parse(
    readFileSync(path.join(state, "team-shape-summary.json"), "utf8"),
  );
  if (!isRecord(summary) || summary.format !== "openclaw-team-shape-v1") {
    throw new Error("--state-dir must be an offline team-shape fixture; never use live state");
  }
  fixture = summary;
}
const config: OpenClawConfig = state
  ? JSON.parse(readFileSync(path.join(state, "openclaw.json"), "utf8"))
  : { ...BASE_GATEWAY_BENCH_CONFIG };
mkdirSync(output); // Never overwrite artifacts from an earlier run.
mkdirSync(path.join(output, "tmp"));
const configPath = path.join(output, "openclaw.json");
const origin = "https://idle-measure.example";
writeFileSync(
  configPath,
  JSON.stringify({
    ...config,
    logging: { ...config.logging, file: path.join(output, "gateway-file.log") },
    gateway: {
      ...config.gateway,
      controlUi: { enabled: false, allowedOrigins: [origin] },
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          allowLoopback: true,
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: ["idle-measure"],
        },
      },
    },
  }),
);
const env = createGatewayBenchEnv(path.join(state ?? output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_SKIP_CHANNELS: "1",
    ...(state ? { OPENCLAW_STATE_DIR: state } : {}),
    TMPDIR: path.join(output, "tmp"),
    OPENCLAW_PROFILE: `idle-measure-${port}`,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-idle-measure-${port}`,
    OPENCLAW_IDLE_MEASURE_CHANNEL: channel,
    OPENCLAW_IDLE_MEASURE_TIMERS: values.timers ? "1" : "0",
    NODE_DISABLE_COMPILE_CACHE: "1",
  },
});
const args = [
  "--trace-gc-nvp",
  "--import",
  path.resolve("scripts/tsx.mjs"),
  "--import",
  path.resolve("scripts/lib/gateway-bench-profile-preload.ts"),
  ...(values.timers
    ? ["--import", path.resolve("scripts/perf/idle-gateway-measure-preload.mjs")]
    : []),
  path.resolve(values.entry),
  "gateway",
  "run",
  "--port",
  String(port),
  "--bind",
  "loopback",
  "--allow-unconfigured",
];
let child: ChildProcess | undefined;
let client: ReturnType<typeof createGatewayWsClient> | undefined;
let failure: Error | undefined;
let closing = false;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Idle measurement interrupted"));
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const wait = (ms: number) => delay(ms, undefined, { signal: abort.signal });
const samples: unknown[] = [];
async function sample() {
  const id = randomUUID();
  const rows: unknown[] = [];
  const onMessage = (message: { channel?: string; id?: string; row?: unknown }) => {
    if (message.channel === channel && message.id === id) {
      rows.push(message.row);
    }
  };
  child!.on("message", onMessage);
  child!.send({ channel, action: "sample", id });
  try {
    await wait(500);
  } finally {
    child!.off("message", onMessage);
  }
  if (!rows.length) {
    throw new Error("No instrumentation response from owned Gateway");
  }
  const value = {
    at: Date.now(),
    load: loadavg(),
    processTreeCpuMs: readProcessTreeCpuMs(child!.pid),
    rows,
  };
  samples.push(value);
  writeFileSync(path.join(output, "samples.json"), JSON.stringify(samples, null, 2));
  return value;
}
try {
  const logPath = path.join(output, "gateway.log");
  const log = openSync(logPath, "wx");
  try {
    child = spawn(process.execPath, args, {
      env,
      detached: true,
      stdio: ["ignore", log, log, "ipc"],
    });
  } finally {
    closeSync(log);
  }
  writeFileSync(path.join(output, "gateway.pid"), String(child.pid));
  const deadline = Date.now() + 180_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`, { signal: abort.signal }).then(
      (r) => r.ok,
      () => false,
    ))
  ) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error("Gateway readiness failed; see gateway.log");
    }
    await wait(250);
  }
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "idle-measure",
    },
  });
  client.ws.on("error", (error) => {
    failure ??= error;
  });
  client.ws.on("close", (code) => {
    if (!closing) {
      failure ??= new Error(`Client disconnected (${code})`);
    }
  });
  await client.waitOpen();
  const connect = await client.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "openclaw-control-ui", version: "1.0.0", platform: process.platform, mode: "ui" },
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [],
  });
  if (!connect.ok) {
    throw new Error(`Connect rejected: ${JSON.stringify(connect.error)}`);
  }
  await wait(settleSeconds * 1000);
  if (startAt !== undefined) {
    if (Date.now() >= startAt) {
      throw new Error("--start-at passed before Gateway readiness and settling completed");
    }
    await wait(startAt - Date.now());
  }
  if (values.timers) {
    child.send({ channel, action: "enable" });
    await sample();
  }
  const cpuProfilePath = path.join(output, "idle.cpuprofile");
  const heapProfilePath = path.join(output, "idle.heapprofile");
  const diagnosticsId = path.join(output, "idle-diagnostics");
  if (values.profile) {
    await controlGatewayProfile(child, "cpu", "start", cpuProfilePath);
  }
  if (values.allocations) {
    await controlGatewayProfile(child, "heap", "start", heapProfilePath, {
      includeCollectedObjects: true,
      includeWorkers: false,
    });
  }
  const stopDiagnostics =
    values.allocations || values.profile
      ? undefined
      : await startGatewayDiagnostics(child, diagnosticsId);
  const cpuBefore = await readGatewayCpuUsage(child);
  const start = Date.now();
  console.log(JSON.stringify({ ready: true, pid: child.pid, start, minutes, output }));
  for (let minute = 1; minute <= minutes; minute++) {
    await wait(Math.max(0, start + minute * 60_000 - Date.now()));
    if (failure) {
      throw failure;
    }
    console.log(
      JSON.stringify({ minute, load: loadavg(), ...(values.timers ? await sample() : {}) }),
    );
  }
  const endedAt = Date.now();
  const cpuAfter = await readGatewayCpuUsage(child);
  if (values.allocations) {
    await controlGatewayProfile(child, "heap", "stop", heapProfilePath);
  }
  const heap = values.allocations
    ? readGatewayHeapProfile(heapProfilePath, { includeCollectedObjects: true })
    : undefined;
  if (values.profile) {
    await controlGatewayProfile(child, "cpu", "stop", cpuProfilePath);
  }
  const profile = values.profile ? readGatewayCpuProfile(cpuProfilePath) : undefined;
  const diagnostics = stopDiagnostics
    ? await stopDiagnostics()
    : (heap?.diagnostics ?? profile?.diagnostics);
  if (!diagnostics || diagnostics.collectionErrors > 0) {
    throw new Error("Idle measurement has incomplete diagnostic accounting");
  }
  const promotion = values.profile
    ? undefined
    : readGatewayGcTrace(
        logPath,
        values.allocations ? heapProfilePath : diagnosticsId,
        values.allocations ? "heap" : "diagnostics",
      );
  writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        scope: "main-isolate",
        runtime: process.version,
        entry: values.entry,
        stateDir: state,
        fixture,
        minutes,
        settleSeconds,
        requestedStartAtEpochMs: startAt,
        startedAtEpochMs: start,
        endedAtEpochMs: endedAt,
        durationMs: endedAt - start,
        timers: values.timers,
        cpu: { ...measureGatewayCpuUsage(cpuBefore, cpuAfter), before: cpuBefore, after: cpuAfter },
        diagnostics,
        promotion,
        profile,
        allocations: heap
          ? {
              ...heap,
              estimatedBytesPerMinute:
                (heap.sampledAllocatedBytes * 60_000) / diagnostics.durationMs,
              estimatedBytesPerSecond: (heap.sampledAllocatedBytes * 1000) / diagnostics.durationMs,
            }
          : undefined,
        samples,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  closing = true;
  client?.close();
  if (child) {
    const teardown = await stopChild(child, { teardownGraceMs: 30_000 });
    writeFileSync(path.join(output, "teardown.json"), JSON.stringify(teardown));
    if (teardown.exitCode !== 0 || teardown.signal !== null || teardown.exitedBeforeTeardown) {
      failure ??= new Error("Gateway teardown failed");
    }
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
if (failure) {
  throw failure;
}
