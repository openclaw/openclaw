// Real stdio registration/initialize/cleanup from an isolated, resident-memory-heavy Gateway.
import assert from "node:assert/strict";
import { ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import {
  constants,
  monitorEventLoopDelay,
  PerformanceObserver,
  type PerformanceEntry,
} from "node:perf_hooks";
import { setImmediate, setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import type { CodexAppServerClient as CodexClient } from "../../extensions/codex/src/app-server/client.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    port: { type: "string", default: "41570" },
    samples: { type: "string", default: "200" },
    "ballast-mib": { type: "string", default: "8192" },
    "start-at": { type: "string" },
    "snapshot-owner": { type: "string" },
    output: { type: "string" },
  },
});
const integer = (raw: string, label: string, min: number) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
assert.equal(process.platform, "linux", "Run on the approved Linux benchmark host");
assert(values["state-dir"] && values.output, "--state-dir and --output are required");
const port = integer(values.port, "--port", 40000);
assert(port <= 65535);
const samples = integer(values.samples, "--samples", 1);
const ballastBytes = integer(values["ballast-mib"], "--ballast-mib", 1) * 1024 * 1024;
const startAt = values["start-at"] ? integer(values["start-at"], "--start-at", 1) : undefined;
const root = path.resolve(values["state-dir"]);
mkdirSync(root); // Never adopt another run's state or orphan registrations.
mkdirSync(path.join(root, "tmp"));
mkdirSync(path.join(root, "home"));
const configPath = path.join(root, "openclaw.json");
writeFileSync(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: {
      defaults: { model: { primary: "synthetic/model" } },
      entries: { main: { workspace: path.join(root, "workspace") } },
    },
    plugins: { enabled: false },
    cron: { enabled: false },
  }),
);
// A synthetic peer needs neither provider credentials nor the operator's home/config.
process.env = createGatewayBenchEnv(root, configPath, {
  startupTrace: false,
  caseEnv: { TMPDIR: path.join(root, "tmp"), OPENCLAW_SKIP_CHANNELS: "1" },
});

let snapshotOwnerLoads = 0;
if (values["snapshot-owner"]) {
  const original = new URL(
    "../../extensions/codex/src/app-server/transport-process-snapshot.ts",
    import.meta.url,
  ).href;
  const replacement = pathToFileURL(path.resolve(values["snapshot-owner"])).href;
  assert.notEqual(original, replacement, "--snapshot-owner must name a baseline sibling file");
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (resolved.url === original) {
        snapshotOwnerLoads++;
        return { ...resolved, url: replacement };
      }
      return resolved;
    },
  });
}

const { startGatewayServer } = await import("../../src/gateway/server.js");
const { CodexAppServerClient } = await import("../../extensions/codex/src/app-server/client.ts");
const { CODEX_APP_SERVER_VERSION } =
  await import("../../extensions/codex/src/app-server/version.ts");
const { createPluginStateKeyedStore } =
  await import("openclaw/plugin-sdk/plugin-state-store-runtime");
const peerPath = path.join(root, "synthetic-codex-peer.cjs");
writeFileSync(
  peerPath,
  `const readline = require("node:readline");
let initialized = false;
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialized") { initialized = true; return; }
  const result = message.method === "initialize"
    ? { userAgent: ${JSON.stringify(`openclaw/${CODEX_APP_SERVER_VERSION}`)} }
    : { initialized };
  process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
});
lines.on("close", () => { process.exitCode = initialized ? 0 : 2; });
`,
);

type SpawnSample = { kind: "peer" | "inspection" | "other"; syncMs: number };
let currentSpawns: SpawnSample[] | undefined;
const spawnDescriptor = Object.getOwnPropertyDescriptor(ChildProcess.prototype, "spawn");
assert(spawnDescriptor && typeof spawnDescriptor.value === "function");
Object.defineProperty(ChildProcess.prototype, "spawn", {
  ...spawnDescriptor,
  value: new Proxy(spawnDescriptor.value, {
    apply(target, receiver, args: unknown[]) {
      const started = performance.now();
      try {
        return Reflect.apply(target, receiver, args);
      } finally {
        const syncMs = performance.now() - started;
        if (currentSpawns) {
          // Inspect only fixture identifiers; never retain argv or environment in the report.
          const options = args[0];
          const argv =
            options !== null && typeof options === "object" && "args" in options
              ? options.args
              : undefined;
          const kind =
            Array.isArray(argv) && argv.includes(peerPath)
              ? "peer"
              : Array.isArray(argv) &&
                  argv.some((arg) => typeof arg === "string" && arg.includes("/proc/"))
                ? "inspection"
                : "other";
          currentSpawns.push({ kind, syncMs });
        }
      }
    },
  }),
});

function summary(input: number[]) {
  const sorted = input.toSorted((a, b) => a - b);
  const percentile = (fraction: number) =>
    sorted[Math.max(0, Math.ceil(input.length * fraction) - 1)] ?? 0;
  return {
    samples: input.length,
    mean: input.reduce((sum, value) => sum + value, 0) / input.length,
    p50: percentile(0.5),
    p95: { value: percentile(0.95), samples: input.length, gateEligible: input.length >= 200 },
    p99: { value: percentile(0.99), samples: input.length, gateEligible: input.length >= 1000 },
    min: sorted[0] ?? 0,
    max: sorted.at(-1) ?? 0,
  };
}

const server = await startGatewayServer(port, { bind: "loopback", controlUiEnabled: false });
const store = createPluginStateKeyedStore<{
  parent: { pid: number };
  child: { pid: number; commandFingerprint: string };
}>("codex", { namespace: "app-server-processes", maxEntries: 512, overflowPolicy: "reject-new" });
const resident: Buffer[] = [];
const rows: Array<{
  startupMs: number;
  cleanupMs: number;
  cpuUs: number;
  mainThreadCpuUs: number;
  rssBytes: number;
  startupSpawns: SpawnSample[];
  cleanupSpawns: SpawnSample[];
}> = [];
let activeClient: CodexClient | undefined;
let measurementStart = Infinity;
let measurementEnd = Infinity;
const gc = { total: { count: 0, durationMs: 0 }, major: { count: 0, durationMs: 0 } };
function observeGc(entries: PerformanceEntry[]) {
  for (const entry of entries) {
    if (entry.startTime < measurementStart || entry.startTime > measurementEnd) {
      continue;
    }
    gc.total.count++;
    gc.total.durationMs += entry.duration;
    if (
      "detail" in entry &&
      typeof entry.detail === "object" &&
      entry.detail !== null &&
      "kind" in entry.detail &&
      entry.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR
    ) {
      gc.major.count++;
      gc.major.durationMs += entry.duration;
    }
  }
}
const observer = new PerformanceObserver((list) => observeGc(list.getEntries()));
const loop = monitorEventLoopDelay({ resolution: 10 });

async function startup() {
  const startupSpawns: SpawnSample[] = [];
  currentSpawns = startupSpawns;
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  const started = performance.now();
  activeClient = await CodexAppServerClient.start({
    transport: "stdio",
    commandSource: "config",
    command: process.execPath,
    args: [peerPath, "app-server"],
    cwd: root,
    env: { CODEX_HOME: path.join(root, "home") },
    headers: {},
  });
  await activeClient.initialize();
  const startupMs = performance.now() - started;
  const usedCpu = process.cpuUsage(cpu);
  const usedThreadCpu = process.threadCpuUsage(threadCpu);
  currentSpawns = undefined;
  assert.equal(startupSpawns.filter((spawn) => spawn.kind === "peer").length, 1);
  assert.equal(activeClient.getServerVersion(), CODEX_APP_SERVER_VERSION);
  assert.deepEqual(await activeClient.request("benchmark/ready", {}), { initialized: true });
  const registrations = await store.entries();
  assert.equal(registrations.length, 1, "startup must durably register exactly one peer");
  assert.equal(registrations[0]?.value.parent.pid, process.pid);
  assert.equal(registrations[0]?.value.child.pid, activeClient.getTransportPid());
  assert.match(registrations[0]?.value.child.commandFingerprint ?? "", /^[a-f0-9]{64}$/);
  const cleanupSpawns: SpawnSample[] = [];
  currentSpawns = cleanupSpawns;
  const closing = performance.now();
  assert.deepEqual(await activeClient.closeAndWait(), { exited: true, cleanup: "closed" });
  const cleanupMs = performance.now() - closing;
  currentSpawns = undefined;
  activeClient = undefined;
  assert.equal((await store.entries()).length, 0, "cleanup must remove the durable registration");
  return {
    startupMs,
    cleanupMs,
    cpuUs: usedCpu.user + usedCpu.system,
    mainThreadCpuUs: usedThreadCpu.user + usedThreadCpu.system,
    rssBytes: process.memoryUsage().rss,
    startupSpawns,
    cleanupSpawns,
  };
}

try {
  // Startup and worker heaps shrink after readiness; fixed ballast preserves the memory shape.
  for (let bytes = 0; bytes < ballastBytes; bytes += 64 * 1024 * 1024) {
    resident.push(Buffer.alloc(Math.min(64 * 1024 * 1024, ballastBytes - bytes), 0x5a));
    await setImmediate();
  }
  await startup(); // Warm module/database setup; cold startup is not mixed into warm samples.
  if (values["snapshot-owner"]) {
    assert(snapshotOwnerLoads > 0, "baseline snapshot owner was not loaded");
  }
  console.log(
    JSON.stringify({ ready: true, pid: process.pid, rssBytes: process.memoryUsage().rss }),
  );
  if (startAt !== undefined) {
    assert(
      startAt > Date.now(),
      "--start-at passed before Gateway, resident memory, and peer readiness",
    );
    await delay(startAt - Date.now());
  }
  observer.observe({ entryTypes: ["gc"] });
  loop.enable();
  measurementStart = performance.now();
  const cpu = process.cpuUsage();
  const threadCpu = process.threadCpuUsage();
  for (let index = 0; index < samples; index++) {
    rows.push(await startup());
  }
  measurementEnd = performance.now();
  const usedCpu = process.cpuUsage(cpu);
  const usedThreadCpu = process.threadCpuUsage(threadCpu);
  loop.disable();
  await setImmediate();
  observeGc(observer.takeRecords());
  const startupSpawns = rows.flatMap((row) => row.startupSpawns);
  const report = {
    boundary:
      "CodexAppServerClient.start + durable process registration + initialize, in a real isolated Gateway",
    exclusions:
      "Synthetic stdio peer; no model turn, account setup, or full run-attempt policy preparation",
    samples,
    gatewayPid: process.pid,
    ballastBytes,
    touchedBufferBytes: resident.reduce((sum, buffer) => sum + buffer.length, 0),
    snapshotOwnerLoads,
    elapsedMs: measurementEnd - measurementStart,
    totalCpuUs: usedCpu.user + usedCpu.system,
    mainThreadCpuUs: usedThreadCpu.user + usedThreadCpu.system,
    startupMs: summary(rows.map((row) => row.startupMs)),
    cleanupMs: summary(rows.map((row) => row.cleanupMs)),
    startupCpuUs: summary(rows.map((row) => row.cpuUs)),
    startupMainThreadCpuUs: summary(rows.map((row) => row.mainThreadCpuUs)),
    rssBytes: summary(rows.map((row) => row.rssBytes)),
    startupSpawns: Object.fromEntries(
      ["peer", "inspection", "other"].map((kind) => {
        const selected = startupSpawns.filter((spawn) => spawn.kind === kind);
        return [
          kind,
          {
            count: selected.length,
            perStartup: selected.length / samples,
            syncMs: selected.length ? summary(selected.map((spawn) => spawn.syncMs)) : null,
          },
        ];
      }),
    ),
    eventLoopDelayMs: {
      samples: loop.count,
      mean: loop.count ? loop.mean / 1e6 : 0,
      p95: {
        value: loop.percentile(95) / 1e6,
        samples: loop.count,
        gateEligible: loop.count >= 200,
      },
      p99: {
        value: loop.percentile(99) / 1e6,
        samples: loop.count,
        gateEligible: loop.count >= 1000,
      },
      max: loop.max / 1e6,
    },
    gc: { ...gc, majorGateEligible: gc.major.count >= 50 },
    rows,
  };
  assert(
    resident.every((buffer) => buffer[0] === 0x5a),
    "resident fixture was not retained",
  );
  assert(
    report.rssBytes.min >= ballastBytes * 0.95,
    "resident memory dropped below the touched ballast",
  );
  writeFileSync(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, rows: undefined }));
} finally {
  currentSpawns = undefined;
  Object.defineProperty(ChildProcess.prototype, "spawn", spawnDescriptor);
  loop.disable();
  observer.disconnect();
  await activeClient?.closeAndWait();
  await server.close({ reason: "synthetic Codex process inspection measurement complete" });
}
