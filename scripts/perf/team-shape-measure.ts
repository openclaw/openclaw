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
  readGatewayHeapProfile,
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
    preload: { type: "string" },
    revision: { type: "string" },
    "start-at": { type: "string" },
    "phase-gap-ms": { type: "string", default: "0" },
    "mutation-ms": { type: "string", default: "0" },
    "prepared-rows": { type: "boolean", default: false },
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
const phaseGapMs = integer(values["phase-gap-ms"], "--phase-gap-ms", 0);
if (values["prepared-rows"] && values["start-at"] && phaseGapMs === 0) {
  throw new Error(
    "--prepared-rows with --start-at requires --phase-gap-ms for aligned CPU and heap phases",
  );
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
  const fixture: unknown = JSON.parse(
    readFileSync(path.join(root, "team-shape-summary.json"), "utf8"),
  );
  if (
    !isRecord(fixture) ||
    fixture.format !== "openclaw-team-shape-v1" ||
    typeof fixture.sessionCount !== "number" ||
    !Number.isSafeInteger(fixture.sessionCount) ||
    fixture.sessionCount < 1
  ) {
    throw new Error(
      "--state-dir must contain a generated team-shape fixture with a positive session count; never use live state",
    );
  }
  const sessionKeyCount = Math.min(999, fixture.sessionCount - 1);
  const fixtureSessionKey = (index: number) =>
    `agent:main:team-shape-session-${sessionKeyCount > 0 ? 1 + (index % sessionKeyCount) : 0}`;
  {
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
import { createHook } from 'node:async_hooks';
import { performance } from 'node:perf_hooks';
const sessionLists = channel('openclaw.session.list');
if (isMainThread) {
  const { onTrustedInternalDiagnosticEvent, setDiagnosticsEnabledForProcess, waitForDiagnosticEventsDrained } =
    await import(${JSON.stringify(new URL("../../src/infra/diagnostic-events.ts", import.meta.url).href)});
  setDiagnosticsEnabledForProcess(true);
  let rows;
  let rowWork;
  let namedStalls;
  let callbacks;
  let turns;
  let callbackStarts = [];
  let turnStart;
  let probeId;
  let schedulingProbe = false;
  let pendingProbe;
  const hook = createHook({
    init(id, type) { if (schedulingProbe && type === 'Immediate') probeId = id; },
    before(id) {
      if (!rows || id === probeId) return;
      const at = performance.now();
      callbackStarts.push(at);
      if (pendingProbe) return;
      turnStart = at;
      schedulingProbe = true;
      pendingProbe = setImmediate(() => {
        if (turns) {
          const elapsed = performance.now() - turnStart;
          turns.count++;
          turns.maxMs = Math.max(turns.maxMs, elapsed);
          if (elapsed > 1000) turns.overOneSecond++;
        }
        pendingProbe = undefined;
      });
      schedulingProbe = false;
    },
    after(id) {
      if (!rows || id === probeId) return;
      const started = callbackStarts.pop();
      if (started === undefined || callbackStarts.length) return;
      const elapsed = performance.now() - started;
      callbacks.count++;
      callbacks.maxMs = Math.max(callbacks.maxMs, elapsed);
      if (elapsed > 1000) callbacks.overOneSecond++;
    },
  });
  sessionLists.subscribe(event => {
    if (rowWork && event.operation === 'sessions.list') rowWork.push({ selected: event.selectedRowCount, dirty: event.dirtyRowCount,
      materialized: event.materializedRowCount, reused: event.reusedRowCount });
  });
  onTrustedInternalDiagnosticEvent(event => {
    if (namedStalls && event.type === 'gateway.main_thread.stall') namedStalls.push({ stalls: event.stalls, dropped: event.dropped });
    if (rows && event.type === 'gateway.rpc' && (${values["prepared-rows"]} || event.method === 'sessions.list')) {
      if (rows.length >= 100000) throw new Error('RPC capture exceeded its bound');
      rows.push({ method: event.method, phase: event.phase, durationMs: event.durationMs,
        admissionMs: event.admissionMs, queueWaitMs: event.queueWaitMs });
    }
  }, { includeTrusted: ['gateway.rpc', 'gateway.main_thread.stall'] });
  process.on('message', async message => {
    if (message?.channel === 'list-rpc-capture' && message.action === 'arm') {
      await waitForDiagnosticEventsDrained();
      rows = []; rowWork = []; namedStalls = []; callbackStarts = [];
      callbacks = { count: 0, maxMs: 0, overOneSecond: 0 };
      turns = { count: 0, maxMs: 0, overOneSecond: 0 };
      hook.enable();
      process.send({ channel: 'list-rpc-capture', action: 'armed' });
      return;
    }
    if (message?.channel !== 'openclaw-gateway-bench-profile' || !['cpu', 'heap'].includes(message.kind)) return;
    if (message.action === 'stop') {
      hook.disable();
      clearImmediate(pendingProbe);
      pendingProbe = undefined;
      await waitForDiagnosticEventsDrained();
      process.send({ channel: 'list-rpc-capture', rows, rowWork, callbacks, turns, namedStalls });
      rows = undefined;
      rowWork = undefined;
      namedStalls = undefined;
    }
  });
}`,
    );
    const profile = `team-shape-${port}`;
    gateway = spawn(
      process.execPath,
      buildGatewayBenchChildArgs(values.entry, port, [
        ...(values["prepared-rows"] ? ["--trace-gc-nvp"] : []),
        "--import",
        "./scripts/tsx.mjs",
        ...(values.preload ? ["--import", path.resolve(values.preload)] : []),
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
  const fixtureAgentCount = typeof fixture.agentCount === "number" ? fixture.agentCount : 1;
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
  if (values["prepared-rows"]) {
    const operations = ["broad", "sidebar", "compact", "describe", "preview", "roster"] as const;
    for (const kind of ["cpu", "heap"] as const) {
      if (kind === "heap" && values["start-at"]) {
        const nextPhaseAt = integer(values["start-at"], "--start-at") + phaseGapMs;
        if (Date.now() >= nextPhaseAt) {
          throw new Error("CPU workload missed the scheduled heap phase; increase --phase-gap-ms");
        }
        await delay(nextPhaseAt - Date.now());
      }
      const profilePath = path.join(output, `prepared-rows.${kind}profile`);
      const timings = new Map<string, number[]>();
      let requestCount = 0;
      let mutations = 0;
      await controlGatewayProfile(child, kind, "start", profilePath);
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer);
          child.off("message", listener);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        };
        const listener = (message: unknown) => {
          if (
            isRecord(message) &&
            message.channel === "list-rpc-capture" &&
            message.action === "armed"
          ) {
            finish();
          }
        };
        const timer = setTimeout(() => finish(new Error("RPC capture arm timed out")), 30_000);
        child.on("message", listener);
        child.send({ channel: "list-rpc-capture", action: "arm" }, (error) => {
          if (error) {
            finish(error);
          }
        });
      });
      const before = await readGatewayCpuUsage(child);
      for (let round = 0; round < samples; round++) {
        const at = performance.now();
        if (
          mutationMs > 0 &&
          round % Math.max(1, Math.ceil(mutationMs / Math.max(1, pollMs))) === 0
        ) {
          await rpc(clients[0]!, "sessions.patch", {
            key: fixtureSessionKey(round),
            label: `Synthetic prepared-row ${kind} ${round}`,
          });
          mutations++;
        }
        await Promise.all(
          clients.map(async (client, index) => {
            const operation = operations[(round + index) % operations.length]!;
            const key = fixtureSessionKey(round * clientCount + index);
            const method =
              operation === "describe"
                ? "sessions.describe"
                : operation === "preview"
                  ? "sessions.preview"
                  : operation === "roster"
                    ? "agents.list"
                    : "sessions.list";
            const params =
              operation === "describe"
                ? { key }
                : operation === "preview"
                  ? { keys: [key], limit: 1, maxChars: 80 }
                  : operation === "roster"
                    ? {}
                    : {
                        limit,
                        archived: "all",
                        source: operation === "compact" ? "agent-roster" : "sessions-page",
                        ...(operation === "broad" ? {} : { rowMode: operation }),
                      };
            const started = performance.now();
            const payload = await rpc(client, method, params);
            if (
              !isRecord(payload) ||
              (method === "sessions.list" &&
                !(typeof payload.count === "number" && payload.count > 0)) ||
              (method === "sessions.describe" && !isRecord(payload.session)) ||
              (method === "sessions.preview" &&
                (!Array.isArray(payload.previews) ||
                  payload.previews.length !== 1 ||
                  !isRecord(payload.previews[0]) ||
                  !["ok", "empty"].includes(String(payload.previews[0].status)))) ||
              (method === "agents.list" &&
                (!Array.isArray(payload.agents) || payload.agents.length !== fixtureAgentCount))
            ) {
              throw new Error(`${operation}: empty or malformed synthetic response`);
            }
            const observed = timings.get(operation) ?? [];
            observed.push(performance.now() - started);
            timings.set(operation, observed);
            requestCount++;
          }),
        );
        if (clientFailure) {
          throw clientFailure;
        }
        if (round + 1 < samples) {
          await delay(Math.max(0, pollMs - (performance.now() - at)));
        }
      }
      const cpu = measureGatewayCpuUsage(before, await readGatewayCpuUsage(child));
      const capture = new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", listener);
          reject(new Error("RPC capture timed out"));
        }, 30_000);
        const listener = (message: unknown) => {
          if (isRecord(message) && message.channel === "list-rpc-capture") {
            clearTimeout(timer);
            child.off("message", listener);
            resolve(message);
          }
        };
        child.on("message", listener);
      });
      await controlGatewayProfile(child, kind, "stop", profilePath);
      const rpcPhases = await capture;
      writeFileSync(
        path.join(output, `prepared-rows.${kind}.capture.json`),
        JSON.stringify(rpcPhases),
      );
      const capturedHandlers =
        isRecord(rpcPhases) && Array.isArray(rpcPhases.rows)
          ? rpcPhases.rows.filter((event: unknown) => isRecord(event) && event.phase === "handler")
              .length
          : 0;
      const profile =
        kind === "cpu" ? readGatewayCpuProfile(profilePath) : readGatewayHeapProfile(profilePath);
      if (
        !profile.diagnostics ||
        profile.diagnostics.collectionErrors ||
        profile.diagnostics.droppedEvents ||
        profile.diagnostics.droppedHistogramSamples ||
        capturedHandlers !== requestCount + mutations
      ) {
        throw new Error(
          `Incomplete diagnostic capture: ${capturedHandlers}/${requestCount + mutations} handlers; see ${output}`,
        );
      }
      const result = {
        variant: "prepared-rows",
        phase: kind,
        requestCount,
        mutations,
        latencyMs: summarize([...timings.values()].flat()),
        operations: Object.fromEntries([...timings].map(([name, rows]) => [name, summarize(rows)])),
        cpu,
        profile,
        rpcPhases,
      };
      results.push(result);
      console.log(JSON.stringify(result));
    }
  }
  for (const phase of values["prepared-rows"] ? [] : (["reconnect", "steady"] as const)) {
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
                key: fixtureSessionKey(mutations),
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
    phaseGapMs,
    reconnectMs,
    results,
  };
  writeFileSync(path.join(output, "result.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, reconnectMs, completed: true }));
} finally {
  await cleanup();
}
