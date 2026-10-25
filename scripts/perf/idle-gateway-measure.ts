// One real connected client; optional config reloads precede the idle window.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
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
    "config-reloads": { type: "string", default: "0" },
    "start-at": { type: "string" },
    port: { type: "string", default: "41563" },
    timers: { type: "boolean", default: false },
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
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const minutes = integer(values.minutes, "--minutes", 1);
const settleSeconds = integer(values["settle-seconds"], "--settle-seconds", 0);
const configReloads = integer(values["config-reloads"], "--config-reloads", 0);
const needsDevice = values.subscribe || configReloads > 0;
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
          ...(needsDevice
            ? { deviceAutoApprove: { enabled: true, scopes: ["operator.read"] } }
            : {}),
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
    NODE_DISABLE_COMPILE_CACHE: "1",
  },
});
const args = [
  ...gatewayBenchCpuProfileArgs(values["cpu-profile-dir"]),
  ...(traceGc ? ["--trace-gc-nvp"] : []),
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
  const scopes = ["operator.read"];
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
  const reloads: Array<{ requests: number; elapsedMs: number }> = [];
  for (let index = 0; index < configReloads; index++) {
    sqlPhase(`reload-${index + 1}`);
    const nextConfig: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
    const level = nextConfig.logging?.level === "debug" ? "info" : "debug";
    nextConfig.logging = { ...nextConfig.logging, level };
    const started = performance.now();
    const pendingPath = `${configPath}.pending`;
    writeFileSync(pendingPath, JSON.stringify(nextConfig));
    renameSync(pendingPath, configPath);
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
    sqlPhase(`reload-settle-${index + 1}`);
    await wait(1000);
  }
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
    sqlPhase(`steady-${minute}`);
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
  const promotion =
    values.profile || !traceGc
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
        reloads,
        subscribe: values.subscribe,
        channels: values.channels,
        sqlOutput,
        cpuProfileDir: values["cpu-profile-dir"],
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
