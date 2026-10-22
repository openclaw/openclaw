// Synthetic loopback sessions.list traffic; the child owns only its fixture.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { SessionsListParams } from "../../packages/gateway-protocol/src/schema/sessions-list.ts";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayCpuProfile,
  readGatewayCpuUsage,
} from "../lib/gateway-bench-profile.ts";
import { buildGatewayBenchChildArgs, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "40967" },
    samples: { type: "string", default: "5" },
    limit: { type: "string", default: "100" },
    clients: { type: "string", default: "35" },
    "poll-ms": { type: "string", default: "5000" },
    "state-dir": { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    revision: { type: "string" },
    "start-at": { type: "string" },
    "mutation-ms": { type: "string", default: "0" },
  },
});
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const port = integer(values.port, "--port", 40000);
if (port > 65535) {
  throw new Error("--port must be between 40000 and 65535");
}
const samples = integer(values.samples, "--samples");
const limit = integer(values.limit, "--limit");
const clientCount = integer(values.clients, "--clients");
const pollMs = integer(values["poll-ms"], "--poll-ms", 0);
const mutationMs = integer(values["mutation-ms"], "--mutation-ms", 0);
if (!values["state-dir"]) {
  throw new Error("--state-dir is required (offline team-shape fixture)");
}
const root = path.resolve(values["state-dir"]);
const output = path.join(root, `list-measure-${Date.now()}`);
const clients: ReturnType<typeof createGatewayWsClient>[] = [];
const parentKey = "agent:main:dashboard:team-shape-list-parent";
let gateway: ChildProcess | undefined;
let closing = false;
let clientFailure: Error | undefined;
const summarize = (numbers: number[]) => {
  const sorted = numbers.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: numbers.length,
    mean: numbers.reduce((a, b) => a + b, 0) / numbers.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
};
async function rpc(client: (typeof clients)[number], method: string, params: unknown) {
  const response = await client.request(method, params, 60_000);
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}
async function connect() {
  const client = createGatewayWsClient({ url: `ws://127.0.0.1:${port}` });
  clients.push(client);
  client.ws.on("error", (error) => {
    clientFailure ??= error;
  });
  client.ws.on("close", (code) => {
    if (!closing) {
      clientFailure ??= new Error(`client closed unexpectedly (${code})`);
    }
  });
  await client.waitOpen();
  await rpc(client, "connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: {
      id: "gateway-client",
      displayName: "synthetic-list-measurement",
      version: "1.0.0",
      platform: process.platform,
      mode: "backend",
    },
    role: "operator",
    scopes: ["operator.read", "operator.admin"],
    caps: [],
  });
  return client;
}
async function closeClients() {
  closing = true;
  await Promise.all(
    clients.splice(0).map(
      (client) =>
        new Promise<void>((resolve) => {
          if (client.ws.readyState === client.ws.CLOSED) {
            resolve();
            return;
          }
          client.ws.once("close", resolve);
          client.close();
        }),
    ),
  );
  closing = false;
}
let cleanupPromise: Promise<void> | undefined;
function cleanup() {
  return (cleanupPromise ??= (async () => {
    await closeClients();
    if (gateway) {
      const result = await stopChild(gateway, { teardownGraceMs: 10_000 });
      if (result.exitCode === null && result.signal === null) {
        throw new Error("Gateway cleanup failed");
      }
    }
  })());
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143));
  });
}
try {
  let fixture: unknown;
  {
    fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
    if (!isRecord(fixture) || fixture.format !== "openclaw-team-shape-v1") {
      throw new Error(
        "--state-dir must contain a generated team-shape fixture; never use live state",
      );
    }
    mkdirSync(output);
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((resolve, reject) => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
    const log = createWriteStream(path.join(output, "gateway.log"));
    const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
    config.diagnostics = { ...config.diagnostics, enabled: true };
    const configPath = path.join(output, "openclaw.json");
    writeFileSync(configPath, JSON.stringify(config));
    const preload = path.join(output, "rpc-preload.mjs");
    writeFileSync(
      preload,
      `import { isMainThread } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
const sessionLists = channel('openclaw.session.list');
if (isMainThread) {
  const { onTrustedInternalDiagnosticEvent, setDiagnosticsEnabledForProcess, waitForDiagnosticEventsDrained } =
    await import(${JSON.stringify(new URL("../../src/infra/diagnostic-events.ts", import.meta.url).href)});
  setDiagnosticsEnabledForProcess(true);
  let rows;
  let rowWork;
  sessionLists.subscribe(event => {
    if (rowWork && event.operation === 'sessions.list') rowWork.push({ selected: event.selectedRowCount, dirty: event.dirtyRowCount,
      materialized: event.materializedRowCount, reused: event.reusedRowCount });
  });
  onTrustedInternalDiagnosticEvent(event => {
    if (rows && event.type === 'gateway.rpc' && event.method === 'sessions.list') {
      if (rows.length >= 100000) throw new Error('RPC capture exceeded its bound');
      rows.push({ phase: event.phase, durationMs: event.durationMs,
        admissionMs: event.admissionMs, queueWaitMs: event.queueWaitMs });
    }
  }, { includeTrusted: ['gateway.rpc'] });
  process.on('message', async message => {
    if (message?.channel !== 'openclaw-gateway-bench-profile' || message.kind !== 'cpu') return;
    if (message.action === 'start') { rows = []; rowWork = []; }
    if (message.action === 'stop') {
      await waitForDiagnosticEventsDrained();
      process.send({ channel: 'list-rpc-capture', rows, rowWork });
      rows = undefined;
      rowWork = undefined;
    }
  });
}`,
    );
    const profile = `team-shape-${port}`;
    gateway = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(values.entry, port, [
        "--import",
        "./scripts/tsx.mjs",
        "--import",
        preload,
        "--import",
        "./scripts/lib/gateway-bench-profile-preload.ts",
      ]),
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
          startupTrace: false,
          caseEnv: {
            OPENCLAW_STATE_DIR: root,
            OPENCLAW_PROFILE: profile,
            TMPDIR: path.join(root, "tmp"),
            OPENCLAW_SKIP_CHANNELS: "1",
            OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-${profile}`,
            OPENCLAW_LAUNCHD_LABEL: `ai.openclaw.${profile}`,
          },
        }),
      },
    );
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    let startup = "";
    let listening = false;
    const observe = (chunk: Buffer) => {
      startup = (startup + chunk.toString()).slice(-4096);
      listening ||= startup.includes("http server listening (");
    };
    gateway.stdout?.on("data", observe);
    gateway.stderr?.on("data", observe);
    const deadline = Date.now() + 180_000;
    while (true) {
      if (gateway.exitCode !== null || gateway.signalCode !== null) {
        throw new Error(`Gateway exited: ${output}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`Gateway readiness timed out: ${output}`);
      }
      if (
        listening &&
        (await fetch(`http://127.0.0.1:${port}/readyz`).then(
          (r) => r.ok,
          () => false,
        ))
      ) {
        break;
      }
      await delay(250);
    }
    await readGatewayCpuUsage(gateway);
    await delay(10_000);
  }
  const variants: Array<{ name: string; params: SessionsListParams }> = [
    { name: "sidebar", params: { rowMode: "sidebar", source: "sidebar" } },
    { name: "general", params: { source: "sessions-page" } },
    { name: "compact", params: { rowMode: "compact", source: "agent-roster" } },
    {
      name: "involving",
      params: {
        rowMode: "sidebar",
        source: "sidebar",
        involvingProfileId: "team-shape-profile-0",
      },
    },
    {
      name: "owner-counts",
      params: {
        source: "sidebar",
        includeOwnerSessionCounts: true,
        limit: 1,
        archived: false,
        includeDerivedTitles: false,
        includeLastMessage: false,
        includeGlobal: false,
        includeUnknown: false,
        excludeSubagents: true,
        excludeCron: true,
        excludeSystem: true,
        excludeDock: true,
      },
    },
    {
      name: "children",
      params: {
        rowMode: "compact",
        source: "chat-pane",
        spawnedBy: parentKey,
      },
    },
  ];
  // Pre-establish the same client count, then discard sockets before the reconnect cohort.
  for (let index = 0; index < clientCount; index++) {
    const client = await connect();
    if (index === 0) {
      await rpc(client, "sessions.create", { key: parentKey, visibility: "shared" });
      for (let child = 0; child < 4; child++) {
        await rpc(client, "sessions.create", {
          key: `agent:main:dashboard:team-shape-list-child-${child}`,
          parentSessionKey: parentKey,
          spawnDepth: 1,
          fork: false,
          visibility: "shared",
        });
      }
    }
  }
  await closeClients();
  console.log(JSON.stringify({ ready: true, output }));
  if (values["start-at"]) {
    const startAt = integer(values["start-at"], "--start-at");
    if (Date.now() >= startAt) {
      throw new Error("--start-at passed before fixture readiness");
    }
    await delay(startAt - Date.now());
  }
  const connectStart = performance.now();
  // 32 is the server's per-IP preauthentication budget; reconnect overflow remains explicit.
  for (let offset = 0; offset < clientCount; offset += 30) {
    await Promise.all(Array.from({ length: Math.min(30, clientCount - offset) }, connect));
  }
  const reconnectMs = performance.now() - connectStart;
  const child = gateway;
  const results = [];
  const revisionsByVariant = new Map(
    variants.map((variant) => [variant.name, new Map<(typeof clients)[number], string>()]),
  );
  for (const phase of ["reconnect", "steady"] as const) {
    for (const variant of variants) {
      const revisions = revisionsByVariant.get(variant.name)!;
      const count = phase === "reconnect" ? 1 : samples;
      const timings: number[] = [];
      const responseBytes: number[] = [];
      const shapes = { full: 0, unchanged: 0, delta: 0 };
      const returnedCounts = new Set<number>();
      const totalCounts = new Set<number>();
      const profilePath = path.join(output, `${variant.name}-${phase}.cpuprofile`);
      await controlGatewayProfile(child, "cpu", "start", profilePath);
      const before = await readGatewayCpuUsage(child);
      let mutations = 0;
      // Exclude the final cohort's tick so response speed cannot change the workload.
      const mutationTarget =
        mutationMs && phase === "steady"
          ? Math.max(0, Math.ceil(((count - 1) * pollMs) / mutationMs) - 1)
          : 0;
      let mutationFailure: unknown;
      let mutation: Promise<void> = Promise.resolve();
      let mutationBusy = false;
      const timer =
        mutationTarget > 0
          ? setInterval(() => {
              if (mutationBusy || mutationFailure || mutations >= mutationTarget) {
                return;
              }
              mutationBusy = true;
              mutation = rpc(clients[0]!, "sessions.patch", {
                key: `agent:main:team-shape-session-${1 + (mutations % 999)}`,
                label: `Synthetic ${variant.name} mutation ${mutations}`,
              })
                .then(
                  () => {
                    mutations++;
                  },
                  (error: unknown) => {
                    mutationFailure = error;
                  },
                )
                .finally(() => {
                  mutationBusy = false;
                });
            }, mutationMs)
          : undefined;
      try {
        for (let index = 0; index < count; index++) {
          const started = performance.now();
          await Promise.all(
            clients.map(async (client) => {
              const at = performance.now();
              const result = await rpc(client, "sessions.list", {
                limit,
                archived: "all",
                ...variant.params,
                ifRowsRevision: revisions.has(client) ? `delta:${revisions.get(client)}` : "",
              });
              if (
                !isRecord(result) ||
                typeof result.count !== "number" ||
                typeof result.totalCount !== "number"
              ) {
                throw new Error("sessions.list returned no session counts");
              }
              if (result.count === 0 || result.totalCount === 0) {
                throw new Error(`${variant.name}: empty fixture result is not a valid measurement`);
              }
              if (
                variant.name === "owner-counts" &&
                (!Array.isArray(result.ownerSessionCounts) ||
                  result.ownerSessionCounts.length === 0)
              ) {
                throw new Error("Owner variant returned no owner counts");
              }
              timings.push(performance.now() - at);
              responseBytes.push(Buffer.byteLength(JSON.stringify(result)));
              returnedCounts.add(result.count);
              totalCounts.add(result.totalCount);
              shapes[result.rowsUnchanged ? "unchanged" : result.rowsDelta ? "delta" : "full"]++;
              if (typeof result.rowsRevision === "string") {
                revisions.set(client, result.rowsRevision);
              }
            }),
          );
          if (clientFailure) {
            throw clientFailure;
          }
          if (index + 1 < count) {
            await delay(Math.max(0, pollMs - (performance.now() - started)));
          }
        }
        const mutationDeadline = performance.now() + 5_000;
        while (performance.now() < mutationDeadline) {
          if (mutations >= mutationTarget || mutationFailure) {
            break;
          }
          await delay(20);
        }
      } finally {
        clearInterval(timer);
        await mutation;
      }
      if (mutationFailure) {
        throw mutationFailure instanceof Error
          ? mutationFailure
          : new Error("Synthetic metadata mutation failed", { cause: mutationFailure });
      }
      if (mutations !== mutationTarget) {
        throw new Error(`Incomplete mutation workload: ${mutations}/${mutationTarget}`);
      }
      const cpu = measureGatewayCpuUsage(before, await readGatewayCpuUsage(child));
      const capture = new Promise<unknown>((resolve, reject) => {
        const captureTimer = setTimeout(() => {
          child.off("message", listener);
          reject(new Error("RPC capture timed out"));
        }, 30_000);
        const listener = (message: unknown) => {
          if (isRecord(message) && message.channel === "list-rpc-capture") {
            clearTimeout(captureTimer);
            child.off("message", listener);
            resolve({ rpc: message.rows, rowWork: message.rowWork });
          }
        };
        child.on("message", listener);
      });
      await controlGatewayProfile(child, "cpu", "stop", profilePath);
      const rpcPhases = await capture;
      const profile = readGatewayCpuProfile(profilePath);
      if (
        !profile.diagnostics ||
        profile.diagnostics.collectionErrors ||
        profile.diagnostics.droppedEvents ||
        profile.diagnostics.droppedHistogramSamples ||
        !isRecord(rpcPhases) ||
        !Array.isArray(rpcPhases.rpc) ||
        !Array.isArray(rpcPhases.rowWork) ||
        rpcPhases.rowWork.length !== timings.length ||
        rpcPhases.rpc.filter((event: unknown) => isRecord(event) && event.phase === "handler")
          .length !== timings.length
      ) {
        throw new Error("Incomplete diagnostic capture");
      }
      const result = {
        variant: variant.name,
        phase,
        request: variant.params,
        latencyMs: summarize(timings),
        responseBytes: summarize(responseBytes),
        shapes,
        returnedCounts: [...returnedCounts],
        totalCounts: [...totalCounts],
        mutations,
        cpu,
        profile,
        rpcPhases,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  const report = {
    revision: values.revision,
    fixture,
    port,
    clientCount,
    samples,
    limit,
    pollMs,
    mutationMs,
    reconnectMs,
    results,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, reconnectMs, completed: true }));
} finally {
  await cleanup();
}
