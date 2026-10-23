// Real Gateway reads on synthetic Team-shaped state; never target a running Gateway.
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { channel } from "node:diagnostics_channel";
import { existsSync, mkdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { constants, monitorEventLoopDelay, PerformanceObserver } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { transformSync } from "esbuild";
import { buildDeviceAuthPayloadV3 } from "../../packages/gateway-client/src/device-auth.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import {
  publicKeyRawBase64UrlFromEd25519Pem,
  signEd25519Payload,
} from "../../src/infra/ed25519-signature.ts";
import { GATEWAY_GC_TRACE_MARKER, readGatewayGcTrace } from "../lib/gateway-bench-profile.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    port: { type: "string", default: "41615" },
    sessions: { type: "string", default: "5000" },
    runs: { type: "string", default: "6000" },
    cron: { type: "string", default: "40" },
    operations: { type: "string", default: "1000" },
    "interval-ms": { type: "string", default: "0" },
    scenario: { type: "string", default: "all" },
    "start-at": { type: "string" },
    "barrier-dir": { type: "string" },
    side: { type: "string", default: "run" },
    "owner-dir": { type: "string" },
    "trace-log": { type: "string" },
  },
});
const integer = (raw: string | undefined, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, fallback: min, min });
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const root = path.resolve(values["state-dir"]);
const port = integer(values.port, "port", 40000);
assert(port <= 65535, "port must be loopback >=40000");
const operations = integer(values.operations, "operations");
const intervalMs = integer(values["interval-ms"], "interval-ms", 0);
const cronJobs = integer(values.cron, "cron", 0);
assert(cronJobs <= 200, "cron workload must fit the 200-row page");
const deliveryOwner = "src/cron/isolated-agent/delivery-target-context.ts";
if (values["owner-dir"]) {
  assert(
    existsSync(path.resolve(values["owner-dir"], deliveryOwner)),
    `--owner-dir must contain ${deliveryOwner}`,
  );
}
const ownerSources: Array<{ path: string; sha256: string; overridden: boolean }> = [];
function markGc(phase: string, profilePath?: string) {
  if (process.execArgv.includes("--trace-gc-nvp")) {
    writeSync(
      1,
      `${GATEWAY_GC_TRACE_MARKER}${JSON.stringify({ phase, pid: process.pid, profilePath })}\n`,
    );
  }
}
if (process.execArgv.includes("--trace-gc-nvp")) {
  assert(global.gc, "trace identification requires --expose-gc");
  markGc("identify-start");
  global.gc();
  markGc("identify-stop");
}
const installed: string[] = [];
let measuring = false;
let observations = new Map<string, number[]>();
const record = (name: string, value: number) => {
  if (measuring && Number.isFinite(value) && value >= 0) {
    const samples = observations.get(name) ?? [];
    samples.push(value);
    observations.set(name, samples);
  }
};
Object.defineProperty(globalThis, Symbol.for("openclaw.bench.local-state-reads"), {
  value: {
    record,
    async run<T>(name: string, work: () => Promise<T>): Promise<T> {
      const start = performance.now();
      try {
        return await work();
      } finally {
        record(name, performance.now() - start);
      }
    },
  },
});
const observer = 'globalThis[Symbol.for("openclaw.bench.local-state-reads")]';
const compile = (source: string) =>
  transformSync(source, { loader: "ts", format: "esm", target: "esnext" }).code;
// Hooks remain private to this benchmark. Unchanged module URLs preserve relative imports.
registerHooks({
  load(url, context, next) {
    const loaded = next(url, context);
    const relative = url.includes("/src/") ? `src/${url.split("/src/").at(-1)}` : undefined;
    let sourcePath: string | URL = new URL(url);
    if (values["owner-dir"] && relative) {
      const alternate = path.resolve(values["owner-dir"], relative);
      if (existsSync(alternate)) {
        sourcePath = alternate;
        loaded.source = compile(readFileSync(alternate, "utf8"));
      }
    }
    if (
      !url.endsWith("/cron/service/locked.ts") &&
      !url.endsWith("/boards/sqlite-board-store.ts") &&
      !url.endsWith("/state/openclaw-agent-write-admission.ts") &&
      !url.endsWith("/scripts/perf/team-shape-extras.ts") &&
      !url.endsWith("/cron/isolated-agent/delivery-target-context.ts")
    ) {
      return loaded;
    }
    // Instrument source before tsx's formatting and export rewriting.
    let source = readFileSync(sourcePath, "utf8");
    if (relative === deliveryOwner) {
      ownerSources.push({
        path: relative,
        sha256: createHash("sha256").update(source).digest("hex"),
        overridden: typeof sourcePath === "string",
      });
    }
    const replace = (before: string, after: string, name: string) => {
      assert(source.includes(before), `source timing hook missing: ${name}`);
      source = source.replace(before, after);
      installed.push(name);
    };
    if (url.endsWith("/scripts/perf/team-shape-extras.ts")) {
      replace(
        'sessionTarget: "main",',
        'sessionTarget: "isolated", delivery: { mode: "announce", channel: "last" },',
        "fixture.delivery",
      );
      replace(
        'payload: { kind: "systemEvent", text: `Synthetic inspection ${index}` },',
        'payload: { kind: "agentTurn", message: `Synthetic inspection ${index}` },',
        "fixture.payload",
      );
    } else if (url.endsWith("/cron/isolated-agent/delivery-target-context.ts")) {
      replace(
        "const result = await readSessionEntriesFromStoreInWorker({",
        `${observer}.record("cron.deliveryFallbackReads", 1); const result = await readSessionEntriesFromStoreInWorker({`,
        "cron.fallback",
      );
    } else if (url.endsWith("/cron/service/locked.ts")) {
      replace(
        "const previous = state.op;",
        "const benchmarkQueuedAt = performance.now(); const previous = state.op;",
        "cron.lock",
      );
      replace(
        "await resolveChain(previous);",
        `await resolveChain(previous); ${observer}.record("cron.queueMs", performance.now() - benchmarkQueuedAt);`,
        "cron.queue",
      );
      replace(
        "return await fn();",
        `return await ${observer}.run("cron.executionMs", fn);`,
        "cron.execution",
      );
    } else if (url.endsWith("/boards/sqlite-board-store.ts")) {
      replace(
        "const value = await worker(reader, captured.sessionKey, env, identity);",
        `const value = await ${observer}.run("board.workerRoundTripMs", () => worker(reader, captured.sessionKey, env, identity));`,
        "board.worker",
      );
    } else {
      const name = "export function runOpenClawAgentBoardReadAdmission";
      const offset = source.indexOf(name);
      assert(offset >= 0, "board read admission hook missing");
      const prefix = source.slice(0, offset);
      source = source.slice(offset);
      replace(
        "const pathname = resolveOpenClawAgentSqlitePath(options);",
        "const benchmarkQueuedAt = performance.now(); const pathname = resolveOpenClawAgentSqlitePath(options);",
        "board.admission",
      );
      replace(
        "fn: run,",
        `fn: () => { ${observer}.record("board.queueMs", performance.now() - benchmarkQueuedAt); return run(); },`,
        "board.queue",
      );
      source = prefix + source;
    }
    return { ...loaded, source: compile(source) };
  },
});

function summary(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const sum = sorted.reduce((total, value) => total + value, 0);
  return {
    samples: sorted.length,
    totalMs: sum,
    meanMs: sorted.length ? sum / sorted.length : null,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}
const diagnosticSubscriptions = [
  "openclaw.gateway.rpc",
  "openclaw.gateway.request.stages",
  "openclaw.worker.task",
  "openclaw.agent-database.reservation",
].map((name) => {
  const source = channel(name);
  const listener = (message: unknown) => {
    if (!measuring || !isRecord(message)) {
      return;
    }
    const operation =
      typeof message.operation === "string"
        ? message.operation
        : typeof message.worker === "string"
          ? message.worker
          : "unknown";
    for (const key of [
      "durationMs",
      "elapsedMs",
      "admissionMs",
      "queueWaitMs",
      "writerExecutionMs",
      "completionDelayMs",
      "queueMs",
      "runMs",
      "transferMs",
    ]) {
      if (typeof message[key] === "number") {
        record(`${name}.${operation}.${key}`, message[key]);
      }
    }
    if (isRecord(message.phaseDurationsMs)) {
      for (const [phase, duration] of Object.entries(message.phaseDurationsMs)) {
        if (typeof duration === "number") {
          record(`${operation}.${phase}Ms`, duration);
        }
      }
    }
  };
  source.subscribe(listener);
  return () => source.unsubscribe(listener);
});
const { generateTeamShapeFixture, parseTeamShapeOptions } = await import("./team-shape-fixture.ts");
const fixture = await generateTeamShapeFixture(
  parseTeamShapeOptions([
    "--state-dir",
    root,
    "--sessions",
    values.sessions!,
    "--runs",
    values.runs!,
    "--settled-runs",
    "--transcript-mib",
    "0",
    "--projects",
    "0",
    "--approvals",
    "0",
    "--cron",
    String(cronJobs),
    "--port",
    String(port),
    "--now",
    String(Date.now()),
  ]),
);
process.env = fixture.env;
delete process.env.OPENCLAW_SKIP_CRON;
const configPath = path.join(root, "openclaw.json");
const config = JSON.parse(readFileSync(configPath, "utf8"));
const origin = `http://127.0.0.1:${port}`;
const email = "reader@local-state-bench.example.test";
config.cron = { ...config.cron, enabled: true };
config.gateway.auth = {
  mode: "trusted-proxy",
  trustedProxy: {
    userHeader: "x-forwarded-user",
    requiredHeaders: ["x-forwarded-proto"],
    allowUsers: [email],
    allowLoopback: true,
    deviceAutoApprove: { enabled: true, scopes: ["operator.admin"] },
  },
  identityScopes: { [email]: ["operator.admin"] },
};
config.gateway.trustedProxies = ["127.0.0.1", "::1"];
config.gateway.controlUi = { enabled: false, allowedOrigins: [origin] };
config.gateway.roles = {
  default: "administrator",
  definitions: {
    administrator: { agents: "*", scopes: ["operator.admin"], sessions: { others: "write" } },
  },
};
writeFileSync(configPath, JSON.stringify(config));
const { startGatewayServer } = await import("../../src/gateway/server.js");
const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
let peer: ReturnType<typeof createGatewayWsClient> | undefined;
let readinessReadFailures = 0;
async function rpc(method: string, params: unknown) {
  assert(peer);
  const response = await peer.request(method, params, 120_000);
  assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
  assert(isRecord(response.payload), `${method}: invalid response`);
  return response.payload;
}
async function waitStart(label: string) {
  let raw = values["start-at"];
  if (values["barrier-dir"]) {
    const directory = path.resolve(values["barrier-dir"]);
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, `${label}.${values.side}.ready`), "ready\n");
    const startFile = path.join(directory, `${label}.start`);
    const deadline = Date.now() + 2 * 60 * 60_000;
    while (!existsSync(startFile)) {
      assert(Date.now() < deadline, "measurement barrier timed out");
      await delay(100);
    }
    raw = readFileSync(startFile, "utf8").trim();
  }
  if (raw) {
    const remaining = integer(raw, "start-at") - Date.now();
    assert(remaining > 0, `missed ${label} start`);
    await delay(remaining);
  }
}
try {
  const deadline = Date.now() + 120_000;
  for (;;) {
    const ready = await fetch(`${origin}/readyz`)
      .then(async (response) => {
        await response.arrayBuffer();
        return response.ok;
      })
      .catch((error: unknown) => {
        readinessReadFailures++;
        if (Date.now() >= deadline) {
          throw error;
        }
        return false;
      });
    if (ready) {
      break;
    }
    assert(Date.now() < deadline, "Gateway readiness timed out");
    await delay(250);
  }
  const challenge = Promise.withResolvers<{ nonce: string; ts: number }>();
  peer = createGatewayWsClient({
    url: `ws://127.0.0.1:${port}`,
    origin,
    headers: {
      "x-forwarded-user": email,
      "x-forwarded-for": "203.0.113.50",
      "x-forwarded-proto": "https",
    },
    onEvent(event) {
      if (event.event === "connect.challenge" && isRecord(event.payload)) {
        challenge.resolve(event.payload as { nonce: string; ts: number });
      }
    },
  });
  await peer.waitOpen();
  const timer = setTimeout(() => challenge.reject(new Error("challenge timeout")), 15_000);
  const { nonce, ts } = await challenge.promise.finally(() => clearTimeout(timer));
  const keys = generateKeyPairSync("ed25519");
  const publicKey = publicKeyRawBase64UrlFromEd25519Pem(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const deviceId = createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex");
  const client = {
    id: "openclaw-control-ui",
    version: "dev",
    platform: "web",
    mode: "webchat",
    instanceId: "local-state-reads",
  };
  const scopes = ["operator.admin"];
  await rpc("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client,
    role: "operator",
    scopes,
    device: {
      id: deviceId,
      publicKey,
      signedAt: ts,
      nonce,
      signature: signEd25519Payload(
        keys.privateKey.export({ type: "pkcs8", format: "pem" }),
        buildDeviceAuthPayloadV3({
          deviceId,
          clientId: client.id,
          clientMode: client.mode,
          platform: client.platform,
          role: "operator",
          scopes,
          signedAtMs: ts,
          nonce,
        }),
      ),
    },
  });
  const sessionKey = "agent:main:local-state-reads";
  await rpc("sessions.create", {
    key: sessionKey,
    visibility: "shared",
    displayName: "Synthetic read target",
  });
  for (let index = 0; index < 3; index++) {
    await rpc("board.widget.put", {
      sessionKey,
      name: `synthetic-${index}`,
      title: `Synthetic ${index}`,
      content: { kind: "html", html: `<p>Synthetic local board ${index}</p>` },
    });
  }
  const availableScenarios = [
    {
      name: "cron.compact",
      method: "cron.list",
      params: { compact: true, includeDisabled: true, limit: 200 },
    },
    { name: "cron.full", method: "cron.list", params: { includeDisabled: true, limit: 200 } },
    { name: "board", method: "board.get", params: { sessionKey } },
    {
      name: "subscribe",
      method: "sessions.messages.subscribe",
      params: { key: sessionKey, subscriptionId: "local-state-reads" },
    },
    { name: "mentions", method: "mentions.list", params: {} },
  ];
  const scenarios = availableScenarios.filter(
    (scenario) => values.scenario === "all" || scenario.name === values.scenario,
  );
  assert(scenarios.length > 0, "unknown --scenario");
  async function read(scenario: (typeof scenarios)[number]) {
    const result = await rpc(scenario.method, scenario.params);
    if (scenario.method === "cron.list") {
      assert(Array.isArray(result.jobs) && result.jobs.length === cronJobs, "cron rows differ");
    }
    if (scenario.method === "board.get") {
      assert(Array.isArray(result.widgets) && result.widgets.length === 3, "board row missing");
    }
    if (scenario.method === "sessions.messages.subscribe") {
      assert(result.subscribed === true && result.key === sessionKey, "subscription missing");
    }
    if (scenario.method === "mentions.list") {
      assert(
        Array.isArray(result.items) && result.items.length === 0,
        "empty Inbox control differs",
      );
    }
    return result;
  }
  const cold: Record<string, unknown> = {};
  for (const scenario of scenarios) {
    observations = new Map();
    measuring = true;
    const start = performance.now();
    await read(scenario);
    cold[scenario.name] = {
      latencyMs: performance.now() - start,
      attribution: Object.fromEntries(
        [...observations].map(([key, samples]) => [key, summary(samples)]),
      ),
    };
    measuring = false;
    for (let warm = 0; warm < 20; warm++) {
      await read(scenario);
    }
  }
  for (const name of [
    "fixture.delivery",
    "fixture.payload",
    "cron.lock",
    "cron.queue",
    "cron.execution",
    "board.worker",
    "board.admission",
    "board.queue",
    "cron.fallback",
  ]) {
    assert(installed.includes(name), `timing hook was not installed: ${name}`);
  }
  assert(
    ownerSources.some((owner) => owner.overridden === Boolean(values["owner-dir"])),
    "expected delivery owner was not loaded",
  );
  if (!values["barrier-dir"]) {
    await waitStart("measure");
  }
  const measurements: Record<string, unknown> = {};
  for (const scenario of scenarios) {
    if (values["barrier-dir"]) {
      await waitStart(scenario.name);
    }
    const pauses: Record<string, number[]> = { minor: [], major: [], other: [] };
    let start = Infinity;
    let end = Infinity;
    const collect = (
      entries: readonly { startTime: number; duration: number; detail?: unknown }[],
    ) => {
      for (const entry of entries) {
        if (entry.startTime < start || entry.startTime > end) {
          continue;
        }
        const kind = isRecord(entry.detail) ? entry.detail.kind : undefined;
        pauses[
          kind === constants.NODE_PERFORMANCE_GC_MINOR
            ? "minor"
            : kind === constants.NODE_PERFORMANCE_GC_MAJOR
              ? "major"
              : "other"
        ]!.push(entry.duration);
      }
    };
    const gc = new PerformanceObserver((list) => collect(list.getEntries()));
    gc.observe({ entryTypes: ["gc"] });
    const loop = monitorEventLoopDelay({ resolution: 1 });
    loop.enable();
    observations = new Map();
    const cpuBefore = process.cpuUsage();
    const mainBefore = process.threadCpuUsage();
    const startedAt = Date.now();
    markGc("diagnostics-start", `${values.output}.${scenario.name}`);
    start = performance.now();
    measuring = true;
    for (let index = 0; index < operations; index++) {
      if (intervalMs > 0) {
        await delay(intervalMs);
      }
      const before = performance.now();
      await read(scenario);
      record("rpc.roundTripMs", performance.now() - before);
    }
    end = performance.now();
    markGc("diagnostics-stop", `${values.output}.${scenario.name}`);
    measuring = false;
    const cpu = process.cpuUsage(cpuBefore);
    const main = process.threadCpuUsage(mainBefore);
    loop.disable();
    await delay(10);
    collect(gc.takeRecords());
    gc.disconnect();
    const totalGcMs = Object.values(pauses)
      .flat()
      .reduce((sum, pause) => sum + pause, 0);
    measurements[scenario.name] = {
      startedAt,
      operations,
      intervalMs,
      elapsedMs: end - start,
      cpuUsPerOperation: (cpu.user + cpu.system) / operations,
      mainCpuUsPerOperation: (main.user + main.system) / operations,
      ...(values["trace-log"]
        ? {
            promotion: readGatewayGcTrace(
              values["trace-log"],
              `${values.output}.${scenario.name}`,
              "diagnostics",
            ),
          }
        : {}),
      gc: {
        totalMs: totalGcMs,
        msPerOperation: totalGcMs / operations,
        kinds: Object.fromEntries(
          Object.entries(pauses).map(([kind, samples]) => [kind, summary(samples)]),
        ),
      },
      loop: {
        samples: loop.count,
        p99Ms: loop.count ? loop.percentile(99) / 1e6 : null,
        maxMs: loop.count ? loop.max / 1e6 : null,
      },
      attribution: Object.fromEntries(
        [...observations].map(([key, samples]) => [key, summary(samples)]),
      ),
    };
  }
  const report = {
    node: process.version,
    intervalMs,
    fixture: fixture.summary,
    installed,
    ownerSources,
    readinessReadFailures,
    cold,
    measurements,
    limitations:
      "Gateway and WebSocket client share a process. CPU includes workers; main CPU includes the client and diagnostic collection. Handler timings are inclusive wall time, not CPU self time. Mentions is an empty-Inbox control. Reads are sequential on one connection, with no foreground model traffic. RPC latency excludes interval waits; elapsed time, CPU, GC, promotion, and event-loop metrics include the whole paced observation window.",
  };
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  measuring = false;
  for (const unsubscribe of diagnosticSubscriptions) {
    unsubscribe();
  }
  peer?.close();
  await server.close({ reason: "synthetic local reads benchmark complete" });
}
