/**
 * Real built-Gateway cron publication probe; synthetic data, no model calls.
 * node --import ./scripts/tsx.mjs scripts/perf/cron-event-rate-measure.ts \
 *   --entry ./dist/entry.js --output .local/cron-event-rate/base --seconds 60
 * Repeat with the candidate build and a separate output directory. Optional
 * --allocation samples collected objects (run separately from timing passes).
 * Two hundred jobs mix short intervals, hourly/daily cron, and future one-shots;
 * four command jobs and two quiet trigger jobs run every thirty seconds.
 * Six Control UI protocol clients consume runtime projections. Count one
 * client's events as producer-inferred broadcasts and all clients as deliveries.
 * Acceptance: fewer duplicate finished/scheduled facts, identical final client
 * runtime state and successful command runs. This is a bounded cron flow probe,
 * not the full Team-shaped concurrent-turn stress campaign or a browser render.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { OperatorScope } from "../../src/gateway/operator-scopes.js";
import { delay, stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import {
  controlGatewayProfile,
  measureGatewayCpuUsage,
  readGatewayHeapProfile,
  readGatewayResources,
  startGatewayDiagnostics,
} from "../lib/gateway-bench-profile.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  parsePositiveInt,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    entry: { type: "string", default: "dist/entry.js" },
    output: { type: "string", default: ".local/cron-event-rate" },
    seconds: { type: "string", default: "60" },
    allocation: { type: "boolean", default: false },
  },
});
const seconds = parsePositiveInt(values.seconds, 60, "--seconds");
assert(seconds >= 60 && seconds % 30 === 0, "--seconds must be a multiple of 30, at least 60");
const output = path.resolve(values.output);
const entry = path.resolve(values.entry);
await mkdir(output, { recursive: true });
const root = await mkdtemp(path.join(output, "synthetic-state-"));
const configPath = path.join(root, "openclaw.json");
const workspace = path.join(root, "workspace");
await mkdir(workspace);
let port = await getFreePort();
while (port < 40_000) {
  port = await getFreePort();
}
const origin = "https://cron-measure.example";
const scopes: OperatorScope[] = ["operator.admin", "operator.read", "operator.write"];
await writeFile(
  configPath,
  JSON.stringify({
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: {
      ownership: "explicit",
      defaults: { systemAgent: { agentId: "main" } },
      entries: { main: { workspace } },
    },
    plugins: { enabled: false },
    cron: { enabled: true, triggers: { enabled: true } },
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      controlUi: { enabled: false, allowedOrigins: [origin] },
      trustedProxies: ["127.0.0.1"],
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          allowLoopback: true,
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: ["cron-measure"],
        },
        identityScopes: { "cron-measure": scopes },
      },
      roles: {
        default: "administrator",
        definitions: {
          administrator: { agents: "*", sessions: { others: "write" }, scopes },
        },
      },
    },
  } satisfies OpenClawConfig),
);
const log = openSync(path.join(output, "gateway.log"), "w");
const gateway = spawn(
  process.execPath,
  [
    "--import",
    new URL("../tsx.mjs", import.meta.url).href,
    "--import",
    new URL("../lib/gateway-bench-profile-preload.ts", import.meta.url).href,
    ...buildGatewayBenchChildArgs(entry, port, [], "trusted-proxy"),
  ],
  {
    detached: process.platform !== "win32",
    stdio: ["ignore", log, log, "ipc"],
    env: createGatewayBenchEnv(root, configPath, {
      startupTrace: false,
      caseEnv: { OPENCLAW_SKIP_CHANNELS: "1" },
    }),
  },
);
closeSync(log);
await writeFile(path.join(output, "gateway-pid.json"), JSON.stringify({ pid: gateway.pid, port }));
type Client = ReturnType<typeof createGatewayWsClient>;
type Runtime = { id: string; value: string; nextRunAtMs: unknown; runningAtMs: unknown };
const clients: Client[] = [];
const views: Array<Map<string, Runtime>> = [];
const actions: Array<Record<string, number>> = [];
const lastEvents = new Map<string, { action: string; value: string }>();
let recording = false;
let duplicateScheduled = 0;
let successfulFinishes = 0;
let quietScheduled = 0;
let setupRateLimitWaits = 0;
const quietIds = new Set<string>();
let failure: Error | undefined;

function runtime(value: unknown): Runtime {
  assert(isRecord(value) && typeof value.id === "string" && isRecord(value.state));
  const jobState = value.state;
  const state = Object.fromEntries(
    [
      "nextRunAtMs",
      "lastRunAtMs",
      "lastDurationMs",
      "lastTriggerEvalAtMs",
      "lastMeaningfulResult",
      "lastRunStatus",
      "lastStatus",
      "runningAtMs",
      "autoDisabled",
    ].map((key) => [key, jobState[key]] as const),
  );
  return {
    id: value.id,
    value: JSON.stringify({ enabled: value.enabled, updatedAtMs: value.updatedAtMs, state }),
    nextRunAtMs: state.nextRunAtMs,
    runningAtMs: state.runningAtMs,
  };
}

async function rpc(client: Client, method: string, params: unknown) {
  assert.ifError(failure);
  let response = await client.request(method, params, 60_000);
  const error = response.error;
  if (
    method === "cron.add" &&
    !response.ok &&
    isRecord(error) &&
    error.code === "UNAVAILABLE" &&
    error.retryable === true &&
    typeof error.retryAfterMs === "number" &&
    isRecord(error.details) &&
    error.details.method === method &&
    error.details.limit === "30 per 60s"
  ) {
    assert(error.retryAfterMs > 0 && error.retryAfterMs <= 60_000);
    setupRateLimitWaits++;
    await delay(error.retryAfterMs);
    response = await client.request(method, params, 60_000);
  }
  assert(response.ok, `${method}: ${JSON.stringify(response.error)}`);
  return response.payload;
}

async function list(client: Client) {
  const response = await rpc(client, "cron.list", {
    includeDisabled: true,
    limit: 200,
    compact: false,
    includeDeliveryPreviews: false,
  });
  assert(isRecord(response) && Array.isArray(response.jobs));
  return response.jobs.map(runtime);
}

try {
  const readyDeadline = Date.now() + 180_000;
  while (
    !(await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      (response) => response.ok,
      () => false,
    ))
  ) {
    assert(
      gateway.exitCode === null && Date.now() < readyDeadline,
      "Gateway failed: see gateway.log",
    );
    await delay(250);
  }
  for (let index = 0; index < 6; index++) {
    const view = new Map<string, Runtime>();
    const counts: Record<string, number> = {};
    views.push(view);
    actions.push(counts);
    const client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin,
      headers: {
        "x-forwarded-for": `192.0.2.${index + 1}`,
        "x-forwarded-proto": "https",
        "x-forwarded-user": "cron-measure",
      },
      onEvent(event) {
        try {
          if (event.event !== "cron" || !isRecord(event.payload)) {
            return;
          }
          const payload = event.payload;
          assert(typeof payload.action === "string");
          const row = runtime(payload.job);
          view.set(row.id, row);
          if (!recording) {
            return;
          }
          counts[payload.action] = (counts[payload.action] ?? 0) + 1;
          if (index === 0) {
            const previous = lastEvents.get(row.id);
            if (
              payload.action === "scheduled" &&
              previous?.action === "finished" &&
              previous.value === row.value
            ) {
              duplicateScheduled++;
            }
            if (payload.action === "finished" && payload.status === "ok") {
              successfulFinishes++;
            }
            if (payload.action === "scheduled" && quietIds.has(row.id)) {
              quietScheduled++;
            }
            lastEvents.set(row.id, { action: payload.action, value: row.value });
          }
        } catch (error) {
          failure ??= error instanceof Error ? error : new Error(String(error));
        }
      },
    });
    clients.push(client);
    client.ws.on("error", (error) => {
      failure ??= error;
    });
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: process.platform,
        mode: "ui",
      },
      role: "operator",
      scopes,
      caps: [],
    });
  }
  const controller = clients[0];
  assert(controller);
  const activeIds: string[] = [];
  const later = new Date(Date.now() + 3 * 3_600_000);
  for (let index = 0; index < 200; index++) {
    const author = clients[index % clients.length];
    assert(author);
    const job = await rpc(author, "cron.add", {
      name: `Synthetic cron ${index}`,
      agentId: "main",
      enabled: index >= 6,
      schedule:
        index < 6
          ? { kind: "every", everyMs: 30_000 }
          : index % 3 === 0
            ? { kind: "every", everyMs: 3_600_000 }
            : index % 3 === 1
              ? {
                  kind: "cron",
                  expr: `${later.getUTCMinutes()} ${later.getUTCHours()} * * *`,
                  tz: "UTC",
                }
              : { kind: "at", at: new Date(Date.now() + 86_400_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: {
        kind: "command",
        argv: [process.execPath, "-e", "process.stdout.write('synthetic cron')"],
      },
      ...(index === 4 || index === 5 ? { trigger: { script: "return { fire: false };" } } : {}),
      delivery: { mode: "none" },
      failureAlert: false,
    });
    assert(isRecord(job) && typeof job.id === "string");
    if (index < 6) {
      activeIds.push(job.id);
    }
    if (index === 4 || index === 5) {
      quietIds.add(job.id);
    }
  }
  for (const view of views) {
    for (const row of await list(controller)) {
      view.set(row.id, row);
    }
  }
  const anchorMs = Date.now() + 10_000;
  for (const id of activeIds) {
    await rpc(controller, "cron.update", {
      id,
      patch: { enabled: true, schedule: { kind: "every", everyMs: 30_000, anchorMs } },
    });
  }
  const heapPath = path.join(output, "allocation.heapprofile");
  const stopDiagnostics = await startGatewayDiagnostics(gateway, "cron-event-rate");
  if (values.allocation) {
    await controlGatewayProfile(gateway, "heap", "start", heapPath, {
      includeCollectedObjects: true,
    });
  }
  const before = await readGatewayResources(gateway);
  const hostLoadBefore = loadavg();
  assert(Date.now() < anchorMs, "Setup crossed the first scheduled run; rerun this sample");
  const eventStart = performance.now();
  recording = true;
  await delay(seconds * 1000);
  recording = false;
  const eventWallMs = performance.now() - eventStart;
  const after = await readGatewayResources(gateway);
  const diagnostics = await stopDiagnostics();
  if (values.allocation) {
    await controlGatewayProfile(gateway, "heap", "stop", heapPath);
  }
  let finalRows = await list(controller);
  const settleDeadline = Date.now() + 30_000;
  while (finalRows.some((row) => row.runningAtMs !== undefined)) {
    assert(Date.now() < settleDeadline, "Cron runs did not settle");
    await delay(100);
    finalRows = await list(controller);
  }
  await delay(100);
  assert.equal(finalRows.length, 200);
  for (const view of views) {
    for (const row of finalRows) {
      assert.equal(view.get(row.id)?.value, row.value, `Client runtime differs for ${row.id}`);
    }
  }
  assert.ifError(failure);
  const waves = seconds / 30;
  assert.equal(
    successfulFinishes,
    waves * 4,
    "Expected every scheduled command to finish successfully",
  );
  assert.equal(
    quietScheduled,
    waves * 2,
    "Expected every quiet trigger to publish its new schedule",
  );
  assert.equal(actions[0]?.started, waves * 6, "Expected one start per scheduled occurrence");
  for (const counts of actions) {
    assert.deepEqual(counts, actions[0], "Connected clients received different event counts");
  }
  const emitted = Object.values(actions[0] ?? {}).reduce((sum, count) => sum + count, 0);
  const report = {
    entry,
    seconds,
    eventWallMs,
    jobs: 200,
    clients: clients.length,
    activeCommands: 4,
    quietTriggers: 2,
    producerInferredEvents: emitted,
    deliveredFrames: emitted * clients.length,
    emitsPerMinute: (emitted * 60_000) / eventWallMs,
    deliveredFramesPerMinute: (emitted * clients.length * 60_000) / eventWallMs,
    actions: actions[0],
    duplicateScheduled,
    successfulFinishes,
    quietScheduled,
    setupRateLimitWaits,
    clientRuntimeMatchesList: true,
    cpu: measureGatewayCpuUsage(before, after),
    memory: { before: before.memory, after: after.memory },
    diagnostics,
    hostLoadBefore,
    hostLoadAfter: loadavg(),
    ...(values.allocation
      ? { allocation: readGatewayHeapProfile(heapPath, { includeCollectedObjects: true }) }
      : {}),
  };
  await writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
} finally {
  for (const client of clients) {
    client.close();
  }
  await stopChild(gateway, { teardownGraceMs: 10_000 });
  await rm(root, { recursive: true, force: true });
}
