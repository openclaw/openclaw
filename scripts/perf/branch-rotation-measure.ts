// Real branch/history/sidebar RPC cohorts against synthetic team-shaped state.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { readGatewayResources } from "../lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    port: { type: "string", default: "41451" },
    clients: { type: "string", default: "40" },
    cohorts: { type: "string", default: "12" },
    "poll-ms": { type: "string", default: "10000" },
    "start-at": { type: "string" },
    revision: { type: "string" },
  },
});
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
if (!values["state-dir"] || !values.output) {
  throw new Error("--state-dir and --output are required; use generated, offline synthetic state");
}
const state = path.resolve(values["state-dir"]);
const output = path.resolve(values.output);
const fixture: unknown = JSON.parse(
  readFileSync(path.join(state, "team-shape-summary.json"), "utf8"),
);
if (!isRecord(fixture) || fixture.format !== "openclaw-team-shape-v1") {
  throw new Error("Expected team-shape fixture; never use live state");
}
const port = integer(values.port, "--port", 40000);
const clientsCount = integer(values.clients, "--clients");
const cohorts = integer(values.cohorts, "--cohorts");
const pollMs = integer(values["poll-ms"], "--poll-ms");
if (port > 65535 || Number(fixture.sessionCount) < clientsCount * 10) {
  throw new Error("Invalid port or insufficient fixture sessions for distinct shared viewers");
}
mkdirSync(output);
const config = JSON.parse(
  readFileSync(path.join(state, "openclaw.json"), "utf8"),
) as OpenClawConfig;
config.gateway = {
  ...config.gateway,
  controlUi: { enabled: false, allowedOrigins: ["https://branch-measure.example"] },
  trustedProxies: ["127.0.0.1"],
  auth: {
    mode: "trusted-proxy",
    trustedProxy: {
      allowLoopback: true,
      userHeader: "x-forwarded-user",
      requiredHeaders: ["x-forwarded-proto"],
      allowUsers: ["branch-measure"],
    },
    identityScopes: { "branch-measure": ["operator.admin", "operator.read", "operator.write"] },
  },
  roles: {
    default: "administrator",
    definitions: {
      administrator: {
        agents: "*",
        sessions: { others: "write" },
        scopes: ["operator.admin", "operator.read", "operator.write"],
      },
    },
  },
};
const configPath = path.join(output, "openclaw.json");
writeFileSync(configPath, JSON.stringify(config));
const env = createGatewayBenchEnv(path.join(state, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_PROFILE: `team-shape-${port}`,
    OPENCLAW_SYSTEMD_UNIT: `openclaw-gateway-team-shape-${port}`,
    TMPDIR: path.join(state, "tmp"),
    OPENCLAW_SKIP_CHANNELS: "1",
  },
});
type Client = ReturnType<typeof createGatewayWsClient>;
type Sample = { phase: string; cohort: number; method: string; elapsedMs: number; rows: number };
const clients: Client[] = [];
const samples: Sample[] = [];
let mutations = 0;
let gateway: ChildProcess | undefined;
let closing = false;
let failure: Error | undefined;
let cleanupPromise: Promise<void> | undefined;
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    closing = true;
    for (const client of clients) {
      client.close();
    }
    if (gateway) {
      let forced = false;
      const outcome = await stopChild(gateway, {
        teardownGraceMs: 30_000,
        killGraceMs: 2000,
        onForceKill: () => {
          forced = true;
        },
      });
      const teardown = { ...outcome, forced };
      writeFileSync(path.join(output, "teardown.json"), `${JSON.stringify(teardown, null, 2)}\n`);
      if (
        forced ||
        outcome.exitedBeforeTeardown ||
        outcome.exitCode !== 0 ||
        outcome.signal !== null
      ) {
        throw new Error(`Gateway teardown failed: ${JSON.stringify(teardown)}`);
      }
    }
  })());
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(
    signal,
    () => void cleanup().finally(() => process.exit(signal === "SIGINT" ? 130 : 143)),
  );
}
async function rpc(client: Client, method: string, params: unknown) {
  if (failure) {
    throw failure;
  }
  const response = await client.request(method, params, 60_000);
  if (!response.ok) {
    throw new Error(`${method}: ${JSON.stringify(response.error)}`);
  }
  return response.payload;
}
async function lifecycle(action: "sample" | "retire-idle") {
  const child = gateway;
  if (!child?.connected) {
    throw new Error("Owned Gateway IPC is unavailable");
  }
  const id = randomUUID();
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off("message", listener);
      reject(new Error("Lifecycle IPC timeout"));
    }, 10_000);
    const listener = (message: unknown) => {
      if (isRecord(message) && message.channel === "branch-rotation-measure" && message.id === id) {
        clearTimeout(timeout);
        child.off("message", listener);
        resolve(message);
      }
    };
    child.on("message", listener);
    child.send({ channel: "branch-rotation-measure", action, id });
  });
}
function summarize(numbers: number[]) {
  const sorted = numbers.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1];
  return {
    count: numbers.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    max: sorted.at(-1),
  };
}
function transcriptWorkers(snapshot: Record<string, unknown>) {
  const rows = snapshot.workerLifecycle;
  if (!Array.isArray(rows)) {
    throw new Error("Lifecycle snapshot has no worker counters");
  }
  const row = rows.find(
    (item: unknown) => isRecord(item) && item.script === "session-transcript.worker.js",
  );
  if (!isRecord(row) || typeof row.started !== "number" || !Array.isArray(row.retired)) {
    throw new Error("No transcript workers observed");
  }
  const retired = row.retired.reduce((total: number, item: unknown) => {
    if (!isRecord(item) || typeof item.count !== "number") {
      throw new Error("Invalid retirement counter");
    }
    return total + item.count;
  }, 0);
  return { started: row.started, retired, active: row.started - retired };
}
async function waitUntil(startAt: number) {
  if (Date.now() >= startAt) {
    throw new Error("Paired phase deadline passed before readiness");
  }
  await delay(startAt - Date.now());
}
async function phase(name: string, startAt: number, count = cohorts) {
  await waitUntil(startAt);
  const startedAt = Date.now();
  const before = {
    lifecycle: await lifecycle("sample"),
    resources: await readGatewayResources(gateway!),
  };
  for (let cohort = 0; cohort < count; cohort++) {
    const started = performance.now();
    // A completed unrelated write defeats the database-token shortcut each cohort.
    await rpc(clients[0]!, "sessions.patch", {
      key: "agent:main:team-shape-session-1",
      verboseLevel: ++mutations % 2 === 1 ? "on" : "off",
    });
    await Promise.all(
      clients.map(async (client, index) => {
        const sessionKey = `agent:main:team-shape-session-${index * 10 + 1}`;
        const requests = [
          { method: "sessions.branches.list", params: { sessionKey }, field: "branches" },
          { method: "chat.history", params: { sessionKey, limit: 20 }, field: "messages" },
          {
            method: "sessions.list",
            params: { limit: 100, rowMode: "sidebar", source: "sidebar", archived: "all" },
            field: "sessions",
          },
        ];
        await Promise.all(
          requests.map(async ({ method, params, field }) => {
            const begin = performance.now();
            const response = await rpc(client, method, params);
            const elapsedMs = performance.now() - begin;
            if (
              !isRecord(response) ||
              !Array.isArray(response[field]) ||
              response[field].length === 0
            ) {
              throw new Error(`${method}: empty or malformed synthetic response`);
            }
            samples.push({ phase: name, cohort, method, elapsedMs, rows: response[field].length });
          }),
        );
      }),
    );
    console.log(JSON.stringify({ phase: name, cohort, elapsedMs: performance.now() - started }));
    if (cohort + 1 < count) {
      await delay(Math.max(0, pollMs - (performance.now() - started)));
    }
  }
  const after = {
    lifecycle: await lifecycle("sample"),
    resources: await readGatewayResources(gateway!),
  };
  const selected = samples.filter((sample) => sample.phase === name);
  const methods = [...new Set(selected.map((sample) => sample.method))];
  const byMethod = (rows: Sample[]) =>
    Object.fromEntries(
      methods.map((method) => [
        method,
        summarize(
          rows.filter((sample) => sample.method === method).map((sample) => sample.elapsedMs),
        ),
      ]),
    );
  return {
    name,
    startedAt,
    endedAt: Date.now(),
    before,
    after,
    latencyMs: byMethod(selected),
    firstCohortLatencyMs: byMethod(selected.filter((sample) => sample.cohort === 0)),
    steadyLatencyMs: byMethod(selected.filter((sample) => sample.cohort > 0)),
  };
}
try {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(port, "127.0.0.1", resolve);
  });
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  const log = createWriteStream(path.join(output, "gateway.log"));
  gateway = spawn(
    process.execPath,
    [
      "--import",
      "./scripts/tsx.mjs",
      "--import",
      "./scripts/lib/gateway-bench-profile-preload.ts",
      "--import",
      "./scripts/perf/branch-rotation-measure-preload.ts",
      values.entry,
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    { env, detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  gateway.stdout?.pipe(log);
  gateway.stderr?.pipe(log);
  writeFileSync(path.join(output, "gateway.pid"), String(gateway.pid));
  const deadline = Date.now() + 180_000;
  while (true) {
    if (gateway.exitCode !== null || gateway.signalCode !== null || Date.now() > deadline) {
      throw new Error("Gateway readiness failed; inspect gateway.log");
    }
    if (
      await fetch(`http://127.0.0.1:${port}/readyz`).then(
        (response) => response.ok,
        () => false,
      )
    ) {
      break;
    }
    await delay(250);
  }
  await delay(10_000);
  for (let index = 0; index < clientsCount; index++) {
    const client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin: "https://branch-measure.example",
      headers: {
        "x-forwarded-for": `192.0.2.${index + 1}`,
        "x-forwarded-proto": "https",
        "x-forwarded-user": "branch-measure",
      },
    });
    clients.push(client);
    client.ws.on("error", (error) => {
      failure ??= error;
    });
    client.ws.on("close", (code) => {
      if (!closing) {
        failure ??= new Error(`Viewer ${index} closed (${code})`);
      }
    });
    await client.waitOpen();
    await rpc(client, "connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        displayName: "Synthetic branch measurement",
        version: "1.0.0",
        platform: process.platform,
        mode: "ui",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
    });
    if (!client.ws.extensions.includes("permessage-deflate")) {
      throw new Error("Viewer compression not negotiated");
    }
  }
  await rpc(clients[0]!, "sessions.patch", {
    key: "agent:main:team-shape-session-1",
    verboseLevel: "off",
  });
  console.log(JSON.stringify({ ready: true, output }));
  const startAt = values["start-at"]
    ? integer(values["start-at"], "--start-at")
    : Date.now() + 1000;
  const coldStartAt = startAt + cohorts * pollMs + 15_000;
  const phases = [await phase("warm", startAt)];
  const retirementBefore = await lifecycle("retire-idle");
  const retirementDeadline = Date.now() + 30_000;
  let retirementAfter: Record<string, unknown>;
  do {
    await delay(100);
    retirementAfter = await lifecycle("sample");
    if (Date.now() > retirementDeadline) {
      throw new Error("Idle transcript retirement did not settle");
    }
  } while (transcriptWorkers(retirementAfter).active !== 0);
  const retirement = { before: retirementBefore, after: retirementAfter };
  phases.push(await phase("cold", coldStartAt));
  const recoveryBefore = await lifecycle("sample");
  // Label-owner discovery deliberately uses the maintenance reader and recreates
  // its scoped connection, distinguishing recovery from a quieter request stream.
  await rpc(clients[0]!, "sessions.patch", {
    key: "agent:main:team-shape-session-1",
    label: `Branch rotation recovery ${startAt}`,
  });
  const recovery = { before: recoveryBefore, after: await lifecycle("sample") };
  phases.push(await phase("recovered", coldStartAt + cohorts * pollMs + 15_000, 2));
  const result = {
    revision: values.revision,
    entry: values.entry,
    fixture,
    clients: clientsCount,
    cohorts,
    pollMs,
    retirement,
    recovery,
    mutations,
    phases,
    samples,
  };
  await cleanup();
  writeFileSync(path.join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  console.log(
    JSON.stringify({
      complete: true,
      phases: phases.map(({ name, latencyMs }) => ({ name, latencyMs })),
    }),
  );
} finally {
  await cleanup();
}
