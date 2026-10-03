// Run only on an isolated validation host after building the dist Gateway.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { toErrorObject } from "../packages/normalization-core/src/error-coercion.ts";
import { isRecord } from "../packages/normalization-core/src/record-coerce.ts";
import { createDeferredCore, type Deferred } from "../src/shared/deferred.ts";
import { applyMockOpenAiModelConfig } from "./e2e/lib/fixtures/mock-openai-config.mjs";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  parsePositiveInt,
  parseCliArgs,
  waitForInitialProbe,
  writeGatewayBenchConfig,
} from "./lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "./lib/gateway-ws-client.ts";

const argv = process.argv.slice(2);
const valueFlags = new Set([
  "--output",
  "--entry",
  "--minutes",
  "--sample-seconds",
  "--snapshot-minutes",
  "--clients",
  "--sessions",
  "--cycle-ms",
  "--reconnect-cycles",
  "--agent-turns",
]);
const flags = parseCliArgs(argv, { booleanFlags: new Set(), valueFlags });
const outputArg = flags.get("--output")?.[0];
if (!outputArg) {
  throw new Error("--output <new artifact directory> is required");
}
const output = path.resolve(outputArg);
if (existsSync(output)) {
  throw new Error(`Artifact directory already exists: ${output}`);
}
const entry = path.resolve(flags.get("--entry")?.[0] ?? "dist/entry.js");
if (!existsSync(entry)) {
  throw new Error(`Build the dist Gateway on the validation host first: ${entry}`);
}
const positive = (flag: string, fallback: number) =>
  parsePositiveInt(flags.get(flag)?.[0], fallback, flag);
const options = {
  minutes: positive("--minutes", 30),
  sampleSeconds: positive("--sample-seconds", 60),
  clients: positive("--clients", 8),
  sessions: positive("--sessions", 300),
  cycleMs: positive("--cycle-ms", 20_000),
  reconnectCycles: positive("--reconnect-cycles", 10),
  agentTurns: positive("--agent-turns", 10),
};
const snapshotMinutes = (flags.get("--snapshot-minutes")?.[0] ?? "5,30").split(",").map(Number);
if (snapshotMinutes.some((value) => !Number.isFinite(value) || value <= 0)) {
  throw new Error("--snapshot-minutes must contain positive minute offsets separated by commas");
}
mkdirSync(output, { recursive: true });
const fixture = mkdtempSync(path.join(tmpdir(), "openclaw-heap-retention-"));
const streams: ReturnType<typeof createWriteStream>[] = [];
const children: ChildProcess[] = [];
const clients = new Set<ReturnType<typeof createGatewayWsClient>>();
const controller = new AbortController();
const methods = new Map<string, { attempted: number; succeeded: number; failed: number }>();
const samples: Array<
  Record<string, unknown> & { elapsedMs: number; rpcCount: number; heapUsed: number }
> = [];
let measured = false;
let measurementGate: Deferred | undefined;
let rpcCount = 0;
const inflight = new Set<Promise<unknown>>();
let connections = 0;
let completedTurns = 0;
let failure: string | undefined;
let startedAt = 0;

function stop() {
  controller.abort();
  measurementGate?.resolve();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function sleep(ms: number) {
  try {
    await delay(ms, undefined, { signal: controller.signal });
  } catch (error) {
    if (!controller.signal.aborted) {
      throw error;
    }
  }
}

function launch(args: string[], env: NodeJS.ProcessEnv, name: string, ipc = false) {
  const child = spawn(process.execPath, args, {
    cwd: process.cwd(),
    env,
    detached: process.platform !== "win32",
    stdio: ipc ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
  });
  children.push(child);
  const stream = createWriteStream(path.join(output, `${name}.log`));
  streams.push(stream);
  child.stdout?.pipe(stream, { end: false });
  child.stderr?.pipe(stream, { end: false });
  return child;
}

async function rpc(
  client: ReturnType<typeof createGatewayWsClient>,
  method: string,
  params: unknown,
) {
  if (measurementGate) {
    await measurementGate.promise;
  }
  if (controller.signal.aborted) {
    throw new Error("Benchmark stopped");
  }
  const counts = methods.get(method) ?? { attempted: 0, succeeded: 0, failed: 0 };
  methods.set(method, counts);
  counts.attempted += 1;
  const request = client.request(method, params, 180_000);
  inflight.add(request);
  try {
    const response = await request;
    if (!response.ok) {
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    }
    counts.succeeded += 1;
    if (measured) {
      rpcCount += 1;
    }
    return response.payload;
  } catch (error) {
    counts.failed += 1;
    throw error;
  } finally {
    inflight.delete(request);
  }
}

async function close(client: ReturnType<typeof createGatewayWsClient>) {
  clients.delete(client);
  if (client.ws.readyState === client.ws.CLOSED) {
    return;
  }
  const closed = once(client.ws, "close");
  client.close();
  const timer = setTimeout(() => client.ws.terminate(), 5_000);
  try {
    await closed;
  } finally {
    clearTimeout(timer);
  }
}

function ipcSample(child: ChildProcess, snapshotPath?: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const cleanup = () => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    const onExit = () => {
      cleanup();
      reject(new Error("Gateway exited before heap measurement completed"));
    };
    const onMessage = (message: unknown) => {
      if (
        !isRecord(message) ||
        message.channel !== "openclaw-heap-retention" ||
        message.id !== id
      ) {
        return;
      }
      cleanup();
      if (message.error) {
        reject(toErrorObject(message.error, "Heap measurement failed"));
      } else {
        resolve(message);
      }
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Heap measurement exceeded five minutes"));
    }, 300_000);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.send({ channel: "openclaw-heap-retention", id, snapshotPath }, (error) => {
      if (error) {
        cleanup();
        reject(error);
      }
    });
  });
}

try {
  const [port, mockPort] = await Promise.all([getFreePort(), getFreePort()]);
  const config: Record<string, unknown> = structuredClone(BASE_GATEWAY_BENCH_CONFIG);
  config.tools = { codeMode: false };
  applyMockOpenAiModelConfig(config, { mockPort, modelRef: "openai/gpt-5.6-luna" });
  if (!isRecord(config.agents) || !isRecord(config.agents.defaults)) {
    throw new Error("Mock configuration did not provide agent defaults");
  }
  config.agents.defaults.heartbeat = { every: "0m" };
  const catalogDir = path.join(fixture, "heap-catalog");
  mkdirSync(catalogDir);
  writeFileSync(
    path.join(catalogDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "heap-retention",
      activation: { onStartup: true },
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
  );
  writeFileSync(
    path.join(catalogDir, "index.cjs"),
    `
module.exports = {
  id: "heap-retention",
  register(api) {
    api.registerSessionCatalog({
      id: "heap-retention",
      label: "Synthetic retention sessions",
      audience: "gateway-operators",
      supportsProcessHomeIsolation: true,
      async list(params) {
        const rows = params.sessionEntries.entriesForAgent(params.agentId);
        return [{
          hostId: "gateway", label: "Synthetic gateway", kind: "gateway", connected: true,
          sessions: rows.slice(0, params.limitPerHost).map(({ sessionKey, entry }) => ({
            threadId: entry.sessionId, sessionKey, name: entry.label || sessionKey,
            status: "idle", updatedAt: entry.updatedAt, archived: false,
            canContinue: false, canArchive: false,
          })),
        }];
      },
      async read(params) {
        return { hostId: params.hostId, threadId: params.threadId, items: [] };
      },
    });
  },
};
`,
  );
  config.plugins = {
    enabled: true,
    load: { paths: [catalogDir] },
    entries: {
      "heap-retention": { enabled: true },
      browser: { enabled: false },
      "memory-core": { config: { dreaming: { enabled: false } } },
    },
  };
  const workspace = path.join(fixture, "workspace");
  mkdirSync(workspace);
  config.agents.entries = { main: { workspace } };
  const configPath = writeGatewayBenchConfig(fixture, config, {});
  const mock = launch(
    ["scripts/e2e/mock-openai-server.mjs"],
    {
      PATH: process.env.PATH,
      MOCK_PORT: String(mockPort),
      SUCCESS_MARKER: "HEAP_RETENTION_OK",
    },
    "mock-provider",
  );
  await once(mock, "spawn");
  const mockReady = await waitForInitialProbe({
    port: mockPort,
    path: "/health",
    startAt: performance.now(),
    deadlineAt: performance.now() + 30_000,
    isDone: () => mock.exitCode !== null || mock.signalCode !== null,
  });
  if (mockReady.status !== 200) {
    throw new Error("Mock provider did not start; inspect mock-provider.log");
  }
  const gateway = launch(
    buildGatewayBenchChildArgs(entry, port, [
      "--expose-gc",
      "--import",
      new URL("./lib/gateway-heap-retention-preload.mjs", import.meta.url).href,
    ]),
    {
      ...createGatewayBenchEnv(fixture, configPath, { caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" } }),
      OPENAI_API_KEY: "synthetic-heap-retention-fixture",
    },
    "gateway",
    true,
  );
  await once(gateway, "spawn");
  const ready = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300_000,
    isDone: () => gateway.exitCode !== null || gateway.signalCode !== null,
  });
  if (ready.status !== 200) {
    throw new Error("Gateway did not start; inspect gateway.log");
  }
  const protocol: unknown = await import(
    pathToFileURL(path.join(path.dirname(entry), "gateway/protocol/index.js")).href
  );
  if (!isRecord(protocol) || typeof protocol.PROTOCOL_VERSION !== "number") {
    throw new Error("Built Gateway protocol version is unavailable");
  }
  const protocolVersion = protocol.PROTOCOL_VERSION;
  async function connect() {
    const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
    clients.add(client);
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: protocolVersion,
      maxProtocol: protocolVersion,
      client: {
        id: "gateway-client",
        displayName: "heap-retention-benchmark",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.read", "operator.write", "operator.admin"],
      caps: [],
    });
    connections += 1;
    await rpc(client, "sessions.subscribe", {});
    return client;
  }
  const seed = await connect();
  const keys = Array.from(
    { length: options.sessions },
    (_, index) => `agent:main:heap-retention-${index}`,
  );
  for (const key of keys) {
    await rpc(seed, "sessions.create", { key, agentId: "main" });
    await rpc(seed, "chat.inject", {
      sessionKey: key,
      message: `Synthetic retention fixture ${key}. `.repeat(32),
    });
  }
  const seededList = await rpc(seed, "sessions.list", { limit: options.sessions });
  if (
    !isRecord(seededList) ||
    !Array.isArray(seededList.sessions) ||
    seededList.sessions.length !== options.sessions
  ) {
    throw new Error("sessions.list did not return every seeded session");
  }
  const seededCatalog = await rpc(seed, "sessions.catalog.list", {
    catalogId: "heap-retention",
    limitPerHost: options.sessions,
  });
  if (!isRecord(seededCatalog) || !Array.isArray(seededCatalog.catalogs)) {
    throw new Error("sessions.catalog.list did not return a catalog");
  }
  const catalogRows = seededCatalog.catalogs
    .flatMap((catalog: unknown) =>
      isRecord(catalog) && Array.isArray(catalog.hosts) ? catalog.hosts : [],
    )
    .flatMap((host: unknown) =>
      isRecord(host) && Array.isArray(host.sessions) ? host.sessions : [],
    );
  if (catalogRows.length !== options.sessions) {
    throw new Error(
      `Synthetic catalog returned ${catalogRows.length}/${options.sessions} seeded sessions`,
    );
  }
  await rpc(seed, "chat.metadata", { sessionKey: keys[0] });
  await close(seed);
  console.log(
    JSON.stringify({
      phase: "seeded",
      sessions: options.sessions,
      options,
      gatewayPid: gateway.pid,
    }),
  );
  const loadClients = await Promise.all(Array.from({ length: options.clients }, () => connect()));
  measured = true;
  startedAt = performance.now();
  const stopAt = startedAt + options.minutes * 60_000;
  async function sample(snapshotMinute?: number) {
    const gate = createDeferredCore();
    measurementGate = gate;
    try {
      // Requests own their timeout; settle all accepted RPCs before measuring the Gateway.
      await Promise.allSettled(inflight);
      const snapshotPath =
        snapshotMinute === undefined
          ? undefined
          : path.join(output, `heap-${snapshotMinute}min.heapsnapshot`);
      const result = await ipcSample(gateway, snapshotPath);
      if (!isRecord(result.memory) || typeof result.memory.heapUsed !== "number") {
        throw new Error("Gateway returned invalid heap sample");
      }
      const item = {
        elapsedMs: performance.now() - startedAt,
        rpcCount,
        connections,
        completedTurns,
        ...result.memory,
        heapUsed: result.memory.heapUsed,
        snapshot: result.snapshot,
        pid: result.pid,
      };
      samples.push(item);
      console.log(JSON.stringify({ phase: "post-gc", ...item }));
      writeFileSync(path.join(output, "samples.json"), JSON.stringify(samples, null, 2));
    } finally {
      measurementGate = undefined;
      gate.resolve();
    }
  }
  await sample();
  const jobs = loadClients.map(async (initialClient, clientIndex) => {
    let client = initialClient;
    let cycle = 0;
    while (performance.now() < stopAt && !controller.signal.aborted) {
      const cycleStart = performance.now();
      const key = keys[(cycle * options.clients + clientIndex) % keys.length]!;
      const subscription = {
        key,
        ...(cycle % 2 === 0 ? { subscriptionId: `heap-${clientIndex}-${cycle}` } : {}),
      };
      await rpc(client, "sessions.messages.subscribe", subscription);
      await rpc(client, "sessions.list", { limit: 100 });
      await rpc(client, "sessions.catalog.list", {
        catalogId: "heap-retention",
        limitPerHost: 100,
        progressId: `heap-${clientIndex}-${cycle}`,
      });
      await rpc(client, "chat.history", { sessionKey: key, limit: 20 });
      await rpc(client, "chat.metadata", { sessionKey: key });
      await rpc(client, "sessions.describe", { key });
      await rpc(client, "sessions.usage", {
        range: "all",
        agentScope: "all",
        limit: options.sessions,
        includeContextWeight: false,
      });
      // A real committed update replaces projection revisions while clients retain subscriptions.
      await rpc(client, "sessions.patch", { key, label: `Retention ${clientIndex}/${cycle}` });
      cycle += 1;
      if (cycle % options.reconnectCycles === 0) {
        await close(client);
        client = await connect();
      } else {
        await rpc(client, "sessions.messages.unsubscribe", subscription);
      }
      await sleep(Math.max(0, options.cycleMs - (performance.now() - cycleStart)));
    }
  });
  jobs.push(
    (async () => {
      const client = await connect();
      for (let index = 0; index < options.agentTurns && !controller.signal.aborted; index += 1) {
        await sleep(
          Math.max(
            0,
            startedAt +
              (index * (options.minutes * 60_000)) / options.agentTurns -
              performance.now(),
          ),
        );
        if (controller.signal.aborted) {
          break;
        }
        const runId = randomUUID();
        const accepted = await rpc(client, "agent", {
          sessionKey: keys[index % keys.length],
          message: "Reply with the synthetic retention marker.",
          deliver: false,
          idempotencyKey: runId,
        });
        if (
          !isRecord(accepted) ||
          accepted.runId !== runId ||
          (accepted.status !== "accepted" && accepted.status !== "ok")
        ) {
          throw new Error(`Agent was not accepted: ${JSON.stringify(accepted)}`);
        }
        const result = await rpc(client, "agent.wait", { runId, timeoutMs: 120_000 });
        if (
          !isRecord(result) ||
          result.status !== "ok" ||
          !isRecord(result.terminalReply) ||
          result.terminalReply.text !== "HEAP_RETENTION_OK"
        ) {
          throw new Error(
            `Agent did not complete against the mock provider: ${JSON.stringify(result)}`,
          );
        }
        completedTurns += 1;
        // Read each committed usage revision through the dashboard entry points.
        await rpc(client, "sessions.usage", {
          range: "all",
          agentScope: "all",
          limit: options.sessions,
          includeContextWeight: false,
        });
        await rpc(client, "usage.cost", { range: "all", agentScope: "all" });
      }
    })(),
  );
  let workloadError: Error | undefined;
  const workload = Promise.all(jobs).catch((error: unknown) => {
    workloadError = toErrorObject(error, "Benchmark workload failed");
    stop();
  });
  const offsets = [
    ...new Set([
      ...Array.from(
        { length: Math.floor((options.minutes * 60) / options.sampleSeconds) },
        (_, index) => (index + 1) * options.sampleSeconds * 1_000,
      ),
      ...snapshotMinutes
        .filter((minute) => minute <= options.minutes)
        .map((minute) => minute * 60_000),
      options.minutes * 60_000,
    ]),
  ].toSorted((left, right) => left - right);
  for (const offset of offsets) {
    await sleep(Math.max(0, startedAt + offset - performance.now()));
    if (controller.signal.aborted) {
      break;
    }
    await sample(snapshotMinutes.find((minute) => Math.abs(minute * 60_000 - offset) < 1));
  }
  await workload;
  if (workloadError) {
    throw workloadError;
  }
  if (samples.at(-1)!.elapsedMs < options.minutes * 60_000) {
    throw new Error("Benchmark interrupted before its final sample");
  }
} catch (error) {
  failure = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.exitCode = 1;
} finally {
  stop();
  await Promise.allSettled([...clients].map(close));
  const cleanup = [];
  for (const child of children.toReversed()) {
    cleanup.push(await stopChild(child));
  }
  for (const stream of streams) {
    stream.end();
  }
  rmSync(fixture, { recursive: true, force: true });
  const first = samples.find((sample) => sample.elapsedMs >= 5 * 60_000) ?? samples[0];
  const last = samples.at(-1);
  const rpcDelta = first && last ? last.rpcCount - first.rpcCount : 0;
  const summary = {
    options,
    entry,
    completed: !failure,
    failure,
    rpcCount,
    connections,
    completedTurns,
    methods: Object.fromEntries(methods),
    samples,
    cleanup,
    measurement:
      first && last
        ? {
            startElapsedMs: first.elapsedMs,
            endElapsedMs: last.elapsedMs,
            startHeapBytes: first.heapUsed,
            endHeapBytes: last.heapUsed,
            heapGrowthBytes: last.heapUsed - first.heapUsed,
            rpcDelta,
            bytesPer1000Rpcs:
              rpcDelta > 0 ? ((last.heapUsed - first.heapUsed) / rpcDelta) * 1_000 : null,
          }
        : null,
  };
  writeFileSync(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ phase: "complete", ...summary }));
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
