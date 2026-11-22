// One real connected client; optional config reloads precede the idle window.
// --fs-census records per-thread filesystem API calls, stream creation/read sizes,
// and worker births (including retired nested workers). API calls are not native
// syscall totals; readFile/open can overlap and SQLite bypasses these wrappers.
// --compile-cache enables the launcher's worker cache and native read diagnostics.
// Keep both counting options separate from uninstrumented CPU/latency acceptance.
// --write-interval-ms exercises real shared-state commits through voicewake.set.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { readGatewayBenchHostCounters, readProcessTreeCpuMs } from "../lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuProfile,
  readGatewayCpuUsage,
  readGatewayGcTrace,
  readGatewayHeapProfile,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    minutes: { type: "string", default: "10" },
    "settle-seconds": { type: "string", default: "60" },
    "ready-timeout-seconds": { type: "string", default: "180" },
    "config-reloads": { type: "string", default: "0" },
    "watcher-failure": { type: "boolean", default: false },
    "start-at": { type: "string" },
    port: { type: "string", default: "41563" },
    timers: { type: "boolean", default: false },
    "fs-census": { type: "boolean", default: false },
    "compile-cache": { type: "boolean", default: false },
    "write-interval-ms": { type: "string" },
    "host-samples": { type: "boolean", default: false },
    profile: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
    subscribe: { type: "boolean", default: false },
    channels: { type: "boolean", default: false },
    "sql-observer": { type: "string" },
    "sql-output": { type: "string" },
    "cpu-profile-dir": { type: "string" },
  },
});
if (!values.output) {
  throw new Error("--output is required (fresh artifact directory)");
}
if (values.profile && values.allocations) {
  throw new Error("Run CPU and allocation profiling separately to exclude profiler teardown");
}
if (Boolean(values["sql-observer"]) !== Boolean(values["sql-output"])) {
  throw new Error("--sql-observer and --sql-output must be supplied together");
}
if (values["watcher-failure"] && values.entry !== "src/entry.ts") {
  throw new Error("--watcher-failure requires --entry src/entry.ts");
}
const sqlOutput = values["sql-output"] ? path.resolve(values["sql-output"]) : undefined;
const sqlPhase = (phase: string) => {
  if (sqlOutput) {
    writeFileSync(path.join(sqlOutput, "phase"), phase);
  }
};
if (sqlOutput) {
  mkdirSync(sqlOutput);
  sqlPhase("boot");
}
const output = path.resolve(values.output);
const instrumented = values.timers || values["fs-census"];
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const minutes = integer(values.minutes, "--minutes", 1);
const settleSeconds = integer(values["settle-seconds"], "--settle-seconds", 0);
const readyTimeoutSeconds = integer(values["ready-timeout-seconds"], "--ready-timeout-seconds", 1);
const configReloads = integer(values["config-reloads"], "--config-reloads", 0);
const writeIntervalMs =
  values["write-interval-ms"] === undefined
    ? 0
    : integer(values["write-interval-ms"], "--write-interval-ms", 1);
const scopes = ["operator.read", ...(writeIntervalMs ? ["operator.write"] : [])];
const needsDevice =
  values.subscribe || configReloads > 0 || values["watcher-failure"] || writeIntervalMs > 0;
const traceGc = configReloads === 0;
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
const censusDirectory = values["fs-census"] ? path.join(output, "fs-census") : undefined;
if (censusDirectory) {
  mkdirSync(censusDirectory);
}
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
          ...(needsDevice ? { deviceAutoApprove: { enabled: true, scopes } } : {}),
        },
      },
    },
  }),
);
const env = createGatewayBenchEnv(path.join(state ?? output, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    ...(values.channels ? {} : { OPENCLAW_SKIP_CHANNELS: "1" }),
    ...(sqlOutput
      ? {
          NODE_OPTIONS: `--require=${JSON.stringify(path.resolve(values["sql-observer"]!))}`,
          SQLMEASURE_OUT: sqlOutput,
        }
      : {}),
    ...(state ? { OPENCLAW_STATE_DIR: state } : {}),
    TMPDIR: process.env.TMPDIR ?? path.join(output, "tmp"),
    OPENCLAW_PROFILE: `idle-measure-${port}`,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-idle-measure-${port}`,
    OPENCLAW_IDLE_MEASURE_CHANNEL: channel,
    OPENCLAW_IDLE_MEASURE_TIMERS: values.timers ? "1" : "0",
    ...(censusDirectory ? { OPENCLAW_IDLE_MEASURE_FS_CENSUS: censusDirectory } : {}),
    OPENCLAW_IDLE_MEASURE_WATCHER_FAILURE: values["watcher-failure"] ? "1" : "0",
    OPENCLAW_BENCH_TRACE_GC: traceGc ? "1" : "0",
    ...(values["compile-cache"]
      ? {
          NODE_COMPILE_CACHE: path.join(output, "compile-cache"),
          NODE_DEBUG_NATIVE: "COMPILE_CACHE",
          // Enter the launcher's post-respawn state: cache worker isolates while
          // preserving this fixture's IPC descriptor and uncached main thread.
          NODE_DISABLE_COMPILE_CACHE: "1",
          OPENCLAW_PACKAGED_COMPILE_CACHE_RESPAWNED: "gateway",
        }
      : { NODE_DISABLE_COMPILE_CACHE: "1" }),
  },
});
const args = [
  ...gatewayBenchCpuProfileArgs(values["cpu-profile-dir"]),
  "--import",
  path.resolve("scripts/tsx.mjs"),
  "--import",
  path.resolve("scripts/lib/gateway-bench-profile-preload.ts"),
  ...(instrumented || values["watcher-failure"]
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
const hostSamples: ReturnType<typeof readGatewayBenchHostCounters>[] = [];
let hostTimer: ReturnType<typeof setInterval> | undefined;
async function watcherCommand(action: "watcher-fail" | "watcher-count") {
  const id = randomUUID();
  const reply = Promise.withResolvers<{ watchNotifications?: number; error?: string }>();
  const onMessage = (message: {
    channel?: string;
    id?: string;
    watchNotifications?: number;
    error?: string;
  }) => {
    if (message.channel === channel && message.id === id) {
      reply.resolve(message);
    }
  };
  child!.on("message", onMessage);
  child!.send({ channel, action, id });
  try {
    const result = await Promise.race([
      reply.promise,
      wait(15_000).then(() => {
        throw new Error(`Watcher command timed out: ${action}`);
      }),
    ]);
    if (result.error) {
      throw new Error(result.error);
    }
    return result;
  } finally {
    child!.off("message", onMessage);
  }
}
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
    // Files retain final snapshots from workers that exited between samples.
    fsCensus: censusDirectory
      ? readdirSync(censusDirectory)
          .filter((name) => name.endsWith(".json"))
          .map((name) => JSON.parse(readFileSync(path.join(censusDirectory, name), "utf8")))
      : undefined,
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
  const deadline = Date.now() + readyTimeoutSeconds * 1000;
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
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  client = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-for": "192.0.2.1",
      "x-forwarded-proto": "https",
      "x-forwarded-user": "idle-measure",
    },
    onEvent(event) {
      if (
        event.event === "connect.challenge" &&
        isRecord(event.payload) &&
        typeof event.payload.nonce === "string" &&
        typeof event.payload.ts === "number"
      ) {
        challenge.resolve({ nonce: event.payload.nonce, ts: event.payload.ts });
      }
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
  const identity = {
    id: "openclaw-control-ui",
    version: "1.0.0",
    platform: process.platform,
    mode: "ui",
  };
  let device;
  if (needsDevice) {
    const { nonce, ts } = await Promise.race([
      challenge.promise,
      wait(12_000).then(() => {
        throw new Error("Control UI challenge timed out");
      }),
    ]);
    const keys = generateKeyPairSync("ed25519");
    const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    );
    const id = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
    device = {
      id,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        buildDeviceAuthPayloadV3({
          deviceId: id,
          clientId: identity.id,
          clientMode: identity.mode,
          platform: identity.platform,
          role: "operator",
          scopes,
          signedAtMs: ts,
          nonce,
        }),
      ),
    };
  }
  const connect = await client.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: identity,
    role: "operator",
    scopes,
    ...(device ? { device } : {}),
    caps: [],
  });
  if (!connect.ok) {
    throw new Error(`Connect rejected: ${JSON.stringify(connect.error)}`);
  }
  if (values.subscribe) {
    const subscription = await client.request("sessions.subscribe", {});
    if (!subscription.ok) {
      throw new Error(`Subscribe rejected: ${JSON.stringify(subscription.error)}`);
    }
  }
  sqlPhase("settle");
  await wait(settleSeconds * 1000);
  const cpuProfilePath = path.join(output, "idle.cpuprofile");
  if (values.profile && values["watcher-failure"]) {
    await controlGatewayProfile(child, "cpu", "start", cpuProfilePath, { includeWorkers: true });
  }
  const reloads: Array<{ requests: number; elapsedMs: number }> = [];
  let watcherRecovery: Awaited<ReturnType<typeof watcherCommand>> | undefined;
  for (let index = 0; index < configReloads + (values["watcher-failure"] ? 1 : 0); index++) {
    const forceFailure = values["watcher-failure"] && index === 0;
    sqlPhase(forceFailure ? "watcher-failure" : `reload-${index + 1}`);
    if (forceFailure) {
      await watcherCommand("watcher-fail");
    }
    const nextConfig: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const level = nextConfig.logging?.level === "debug" ? "info" : "debug";
    nextConfig.logging = { ...nextConfig.logging, level };
    const started = performance.now();
    const pendingPath = `${configPath}.pending`;
    writeFileSync(pendingPath, JSON.stringify(nextConfig));
    renameSync(pendingPath, configPath);
    if (forceFailure) {
      // Observe after the bounded first recovery, without adding latency-dependent RPC polling.
      await wait(2000);
    }
    let requests = 0;
    for (;;) {
      const response = await client.request("config.get", {});
      requests++;
      const snapshot = response.payload;
      if (!response.ok || !isRecord(snapshot)) {
        throw new Error("Config reload observation failed");
      }
      if (
        isRecord(snapshot.config) &&
        isRecord(snapshot.config.logging) &&
        snapshot.config.logging.level === level &&
        typeof snapshot.configRevisionHash === "string" &&
        snapshot.appliedConfigHash === snapshot.configRevisionHash
      ) {
        break;
      }
      if (performance.now() - started > 30_000) {
        throw new Error("Config reload did not publish its applied revision");
      }
      await wait(100);
    }
    reloads.push({ requests, elapsedMs: performance.now() - started });
    if (forceFailure) {
      await wait(2000);
      watcherRecovery = await watcherCommand("watcher-count");
    }
    sqlPhase(`reload-settle-${index + 1}`);
    await wait(1000);
  }
  if (startAt !== undefined) {
    if (Date.now() >= startAt) {
      throw new Error("--start-at passed before Gateway readiness and settling completed");
    }
    await wait(startAt - Date.now());
  }
  if (instrumented) {
    child.send({ channel, action: "enable" });
    await sample();
  }
  const heapProfilePath = path.join(output, "idle.heapprofile");
  const diagnosticsId = path.join(output, "idle-diagnostics");
  if (values.profile && !values["watcher-failure"]) {
    await controlGatewayProfile(child, "cpu", "start", cpuProfilePath, { includeWorkers: true });
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
  const compileLogStart = values["compile-cache"] ? statSync(logPath).size : 0;
  const writeRequests: Array<{
    scheduledAtEpochMs: number;
    startedAtEpochMs: number;
    endedAtEpochMs: number;
    elapsedMs: number;
  }> = [];
  let lastTrigger: string | undefined;
  let nextWrite = start;
  if (values["host-samples"]) {
    hostSamples.push(readGatewayBenchHostCounters());
    hostTimer = setInterval(() => hostSamples.push(readGatewayBenchHostCounters()), 1000);
    hostTimer.unref();
  }
  console.log(JSON.stringify({ ready: true, pid: child.pid, start, minutes, output }));
  for (let minute = 1; minute <= minutes; minute++) {
    sqlPhase(`steady-${minute}`);
    const until = start + minute * 60_000;
    if (writeIntervalMs) {
      while (Date.now() < until) {
        await wait(Math.max(0, Math.min(nextWrite, until) - Date.now()));
        if (Date.now() >= until) {
          break;
        }
        const trigger = `synthetic-wake-${writeRequests.length % 2}`;
        const began = performance.now();
        const reply = await client.request("voicewake.set", { triggers: [trigger] });
        if (
          !reply.ok ||
          !isRecord(reply.payload) ||
          !Array.isArray(reply.payload.triggers) ||
          reply.payload.triggers.length !== 1 ||
          reply.payload.triggers[0] !== trigger
        ) {
          throw new Error(`Shared-state write failed: ${JSON.stringify(reply)}`);
        }
        const ended = performance.now();
        writeRequests.push({
          scheduledAtEpochMs: nextWrite,
          startedAtEpochMs: performance.timeOrigin + began,
          endedAtEpochMs: performance.timeOrigin + ended,
          elapsedMs: ended - began,
        });
        lastTrigger = trigger;
        nextWrite = Math.max(nextWrite + writeIntervalMs, Date.now());
      }
    } else {
      await wait(Math.max(0, until - Date.now()));
    }
    if (failure) {
      throw failure;
    }
    console.log(
      JSON.stringify({ minute, load: loadavg(), ...(instrumented ? await sample() : {}) }),
    );
  }
  const endedAt = Date.now();
  clearInterval(hostTimer);
  if (values["host-samples"]) {
    hostSamples.push(readGatewayBenchHostCounters());
  }
  const compileLogEnd = values["compile-cache"] ? statSync(logPath).size : 0;
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
  const promotion =
    values.profile || !traceGc
      ? undefined
      : readGatewayGcTrace(
          logPath,
          values.allocations ? heapProfilePath : diagnosticsId,
          values.allocations ? "heap" : "diagnostics",
        );
  if (lastTrigger !== undefined) {
    const reply = await client.request("voicewake.get", {});
    if (
      !reply.ok ||
      !isRecord(reply.payload) ||
      !Array.isArray(reply.payload.triggers) ||
      reply.payload.triggers.length !== 1 ||
      reply.payload.triggers[0] !== lastTrigger
    ) {
      throw new Error("Shared-state write readback did not match the final acknowledged trigger");
    }
  }
  const writeLatencies = writeRequests.map((request) => request.elapsedMs);
  const sortedWriteLatencies = writeLatencies.toSorted((a, b) => a - b);
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
        reloads,
        watcherRecovery,
        subscribe: values.subscribe,
        channels: values.channels,
        sqlOutput,
        cpuProfileDir: values["cpu-profile-dir"],
        requestedStartAtEpochMs: startAt,
        startedAtEpochMs: start,
        endedAtEpochMs: endedAt,
        durationMs: endedAt - start,
        timers: values.timers,
        fsCensus: values["fs-census"],
        writes: writeIntervalMs
          ? {
              intervalMs: writeIntervalMs,
              count: writeLatencies.length,
              readbackVerified: lastTrigger !== undefined,
              latenciesMs: writeLatencies,
              requests: writeRequests,
              medianMs: sortedWriteLatencies[Math.floor(sortedWriteLatencies.length / 2)],
              p95Ms: sortedWriteLatencies[Math.ceil(sortedWriteLatencies.length * 0.95) - 1],
            }
          : undefined,
        // Native compile-cache reads bypass JS filesystem wrappers. This diagnostic
        // count covers the measured log byte range and excludes boot/shutdown.
        compileCache: values["compile-cache"]
          ? {
              reads: (
                readFileSync(logPath)
                  .subarray(compileLogStart, compileLogEnd)
                  .toString()
                  .match(/\[compile cache\] reading cache from /g) ?? []
              ).length,
              logStart: compileLogStart,
              logEnd: compileLogEnd,
            }
          : undefined,
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
        hostSamples: values["host-samples"] ? hostSamples : undefined,
      },
      null,
      2,
    ),
  );
} catch (error) {
  failure = error instanceof Error ? error : new Error(String(error));
} finally {
  clearInterval(hostTimer);
  sqlPhase("shutdown");
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
