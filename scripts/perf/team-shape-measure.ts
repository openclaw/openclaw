// Synthetic loopback sessions.list traffic; the child owns only its fixture.
// Cold restart burst (65 clients, one cold + one warm full sidebar page, no preconditioning):
// node --import ./scripts/tsx.mjs scripts/perf/team-shape-measure.ts --cold-burst \
//   --state-dir <synthetic-fixture> --entry <already-built-revision>/dist/entry.js
// Repeat against each revision with the same fixture; result.json records selection equality,
// startup/connect timings, client samples, raw handler phases/work, and host load.
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { loadavg } from "node:os";
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
    clients: { type: "string" },
    "cold-burst": { type: "boolean", default: false },
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
const coldBurst = values["cold-burst"];
const clientCount = integer(values.clients ?? (coldBurst ? "65" : "35"), "--clients");
const pollMs = integer(values["poll-ms"], "--poll-ms", 0);
const mutationMs = integer(values["mutation-ms"], "--mutation-ms", 0);
if (
  coldBurst &&
  (path.basename(values.entry) !== "entry.js" ||
    path.basename(path.dirname(path.resolve(values.entry))) !== "dist" ||
    values["start-at"] ||
    mutationMs)
) {
  throw new Error("--cold-burst requires a built dist/entry.js and no --start-at or mutations");
}
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
async function connectCohort() {
  // 32 is the server's per-IP preauthentication budget.
  for (let offset = 0; offset < clientCount; offset += 30) {
    await Promise.all(Array.from({ length: Math.min(30, clientCount - offset) }, connect));
  }
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
async function measure() {
  let fixture: unknown;
  let startedAt: number;
  let processStarted: number;
  let readyMs: number;
  const hostLoadBefore = loadavg();
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
      coldBurst
        ? `import { isMainThread } from 'node:worker_threads';
import { channel } from 'node:diagnostics_channel';
if (isMainThread) {
  let rows = [];
  channel('openclaw.session.list').subscribe(event => {
    if (event.operation !== 'sessions.list' || rows.length >= ${clientCount * 2}) return;
    const row = { phaseDurationsMs: event.phaseDurationsMs };
    for (const key of ['handlerElapsedMs', 'prepareThreadCpuMs', 'rowThreadCpuMs',
      'responseThreadCpuMs', 'prepareSyncMs', 'rowSyncMs', 'yieldWaitMs', 'yieldCount',
      'selectedRowCount', 'dirtyRowCount', 'materializedRowCount', 'reusedRowCount']) {
      if (typeof event[key] === 'number') row[key] = event[key];
    }
    rows.push(row);
  });
  process.on('message', message => {
    if (message?.channel !== 'cold-list-capture') return;
    process.channel?.ref();
    process.send({ channel: 'cold-list-capture', rows }, () => process.channel?.unref());
    rows = [];
  });
  process.channel?.unref();
}`
        : `import { isMainThread } from 'node:worker_threads';
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
      process.channel?.ref();
      await waitForDiagnosticEventsDrained();
      process.send({ channel: 'list-rpc-capture', rows, rowWork }, () => process.channel?.unref());
      rows = undefined;
      rowWork = undefined;
    }
  });
  process.channel?.unref();
}`,
    );
    const profile = `team-shape-${port}`;
    startedAt = Date.now();
    processStarted = performance.now();
    gateway = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(
        values.entry,
        port,
        coldBurst
          ? ["--import", preload]
          : [
              "--import",
              "./scripts/tsx.mjs",
              "--import",
              preload,
              "--import",
              "./scripts/lib/gateway-bench-profile-preload.ts",
            ],
      ),
      {
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        env: createGatewayBenchEnv(path.join(root, "home"), configPath, {
          startupTrace: coldBurst,
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
      await delay(coldBurst ? 25 : 250);
    }
    readyMs = performance.now() - processStarted;
    if (!coldBurst) {
      await readGatewayCpuUsage(gateway);
      await delay(10_000);
    }
  }
  if (coldBurst) {
    await connectCohort();
    const connectedMs = performance.now() - processStarted;
    const child = gateway;
    const results = [];
    let selection: { keys: string[]; totalCount: number } | undefined;
    let equalSelection = true;
    for (const phase of ["cold", "warm"] as const) {
      const cohort = await Promise.all(
        clients.map(async (client) => {
          const at = performance.now();
          const result = await rpc(client, "sessions.list", {
            source: "sidebar",
            rowMode: "sidebar",
            limit,
            archived: false,
          });
          const finishedMs = performance.now() - processStarted;
          const latencyMs = performance.now() - at;
          if (
            !isRecord(result) ||
            !Array.isArray(result.sessions) ||
            !result.sessions.length ||
            result.count !== result.sessions.length ||
            typeof result.totalCount !== "number" ||
            result.totalCount < result.sessions.length
          ) {
            throw new Error("Cold burst requires a nonempty full sessions.list result");
          }
          const keys = result.sessions.map((row: unknown) => {
            if (!isRecord(row) || typeof row.key !== "string") {
              throw new Error("sessions.list returned a row without its stable key");
            }
            return row.key;
          });
          const selected = { keys, totalCount: result.totalCount };
          selection ??= selected;
          equalSelection &&= JSON.stringify(selected) === JSON.stringify(selection);
          return { latencyMs, finishedMs, count: keys.length, totalCount: result.totalCount };
        }),
      );
      if (clientFailure) {
        throw clientFailure;
      }
      const handlers = await new Promise<unknown[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", listener);
          reject(new Error("Cold burst handler capture timed out"));
        }, 30_000);
        const listener = (message: unknown) => {
          if (!isRecord(message) || message.channel !== "cold-list-capture") {
            return;
          }
          clearTimeout(timer);
          child.off("message", listener);
          if (!Array.isArray(message.rows) || message.rows.length !== clientCount) {
            reject(new Error("Incomplete cold burst handler capture"));
            return;
          }
          resolve(message.rows);
        };
        child.on("message", listener);
        child.send({ channel: "cold-list-capture" });
      });
      results.push({
        phase,
        latencyMs: summarize(cohort.map((sample) => sample.latencyMs)),
        firstResultFromStartMs: Math.min(...cohort.map((sample) => sample.finishedMs)),
        samples: cohort,
        handlers,
      });
    }
    const report = {
      mode: "cold-burst",
      revision: values.revision,
      entry: path.resolve(values.entry),
      fixture,
      port,
      clientCount,
      limit,
      startedAt,
      readyMs,
      connectedMs,
      reconnectMs: connectedMs - readyMs,
      hostLoadBefore,
      hostLoadAfter: loadavg(),
      selection,
      equalSelection,
      results,
    };
    writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
    if (!equalSelection) {
      throw new Error(`Cold/warm session selections differ: ${output}`);
    }
    console.log(
      JSON.stringify({
        output,
        completed: true,
        readyMs,
        connectedMs,
        equalSelection,
        results: results.map((result) => ({
          phase: result.phase,
          latencyMs: result.latencyMs,
          firstResultFromStartMs: result.firstResultFromStartMs,
        })),
      }),
    );
    return;
  }
  const variants: Array<{ name: string; params: SessionsListParams }> = [
    { name: "sidebar", params: { rowMode: "sidebar", source: "sidebar" } },
    { name: "general", params: { source: "sessions-page" } },
    {
      name: "runtime-search",
      params: { source: "sessions-page", search: "openclaw", archived: "all" },
    },
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
  await connectCohort();
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
              if (
                variant.name === "runtime-search"
                  ? result.count !== 0 || result.totalCount !== 0
                  : result.count === 0 || result.totalCount === 0
              ) {
                throw new Error(`${variant.name}: unexpected fixture result counts`);
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
}
try {
  await measure();
} finally {
  await cleanup();
}
