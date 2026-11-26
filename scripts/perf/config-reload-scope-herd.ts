/**
 * Real isolated Gateway + N simulated UI subscribers + config.patch.
 * Seed with team-shape-fixture.ts; never accepts a live URL or operator state.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/config-reload-scope-herd.ts \
 *   --state-dir <synthetic-fixture> --output <new.json> --clients 14
 * --baseline-dir loads the original server and UI owners into the same source graph.
 * Run A/A then interleaved baseline/candidate processes, at least five pairs.
 * --allocations and --cpu-profile are separate diagnostic runs. Counts include
 * simulated subscriptions; explicit models.list probes are reported separately.
 * Every process warms each burst kind before timing. --controls-only measures
 * duplicate no-op/model controls for A/A. Start below 8 one-minute load.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import type { SessionRowChange } from "../../src/sessions/session-row-changes.js";
import { modelCatalogEventInvalidation } from "../../ui/src/lib/model-catalog-cache.ts";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { registerPerfOwnerReplacement } from "../lib/perf-owner-replacement.ts";

const { values } = parseArgs({
  options: {
    "state-dir": { type: "string" },
    output: { type: "string" },
    "baseline-dir": { type: "string" },
    clients: { type: "string", default: "14" },
    allocations: { type: "boolean" },
    "cpu-profile": { type: "boolean" },
    "controls-only": { type: "boolean" },
  },
});
assert(values["state-dir"] && values.output);
const startLoad = loadavg();
assert(startLoad[0]! < 8, "Arm must start below 8 one-minute load");
const root = path.resolve(values["state-dir"]);
const fixture = JSON.parse(readFileSync(path.join(root, "team-shape-summary.json"), "utf8"));
const count = Number(values.clients);
assert(Number.isSafeInteger(count) && count > 0 && count <= 64);
const replaced = [
  "src/config/runtime-snapshot-value-fact.ts",
  "src/config/runtime-session-changes.ts",
  "src/config/resolution-facts.ts",
  "src/config/read-dependencies.ts",
  "src/state/user-channel-identity-operations.ts",
].map((file) =>
  registerPerfOwnerReplacement(
    new URL(`../../${file}`, import.meta.url).href,
    values["baseline-dir"]
      ? path.join(
          values["baseline-dir"],
          file === "src/config/read-dependencies.ts" ? "ui/src/lib/config-change.ts" : file,
        )
      : undefined,
  ),
);
// Register before importing the subscriber: both arms must exercise their own UI predicate.
const { isConversationConfigChange } = await import("../../src/config/read-dependencies.js");
const configPath = path.join(root, "openclaw.json");
process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: true,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    TMPDIR: path.join(root, "tmp"),
  },
});
const port = await getFreePort();
const token = "synthetic-config-reload-proof";
const config: OpenClawConfig = JSON.parse(readFileSync(configPath, "utf8"));
const logPath = path.join(root, "reload-scope-gateway.log");
config.logging = { ...config.logging, file: logPath, level: "info" };
config.ui = { ...config.ui, prefs: { ...config.ui?.prefs, chatShowToolCalls: true } };
writeFileSync(logPath, "");
config.gateway = {
  ...config.gateway,
  port,
  auth: { mode: "token", token },
  controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
};
config.browser = { enabled: false, profiles: {} };
config.plugins = {
  enabled: true,
  allow: ["browser"],
  slots: { memory: "none" },
  entries: { browser: { enabled: true } },
};
config.agents = {
  ...config.agents,
  defaults: {
    ...config.agents?.defaults,
    skipBootstrap: true,
    skills: [],
    model: { primary: "fixture/first" },
    modelPolicy: { allow: ["fixture/first", "fixture/second"] },
    models: { "fixture/first": {}, "fixture/second": {} },
  },
};
const workspace = path.join(root, "fixture-worktrees/team-shape-project-0");
if (existsSync(workspace)) {
  config.agents.defaults!.workspace = workspace;
  for (const agent of Object.values(config.agents.entries ?? {})) {
    agent.workspace = workspace;
  }
}
config.models = {
  providers: {
    fixture: {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: "synthetic",
      models: ["first", "second"].map((id) => ({
        id,
        name: id,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32768,
        maxTokens: 1024,
      })),
    },
  },
};
writeFileSync(configPath, JSON.stringify(config));
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const { getRuntimeConfig } = await import("../../src/config/io.js");
const { getPublishedPreparedModelCatalogOwnerSnapshot } =
  await import("../../src/agents/prepared-model-catalog.js");
const { sessionChanges } = await import("../../src/sessions/session-row-changes.js");
const { registerPreparedModelRuntimePublicationListener } =
  await import("../../src/agents/prepared-model-runtime.js");
const { requestGatewayRestartWithSignalAdmission } = await import("../../src/infra/restart.js");
const { withAgentDatabaseStartupAdmission } =
  await import("../../src/state/agent-database-startup.js");
const { server, databaseStartup } = await withAgentDatabaseStartupAdmission(async (admission) => ({
  server: await startGatewayServer(port, {
    bind: "loopback",
    controlUiEnabled: false,
    hotReloadRecovery: requestGatewayRestartWithSignalAdmission,
  }),
  databaseStartup: admission,
}));
await server.startupSettled;
// Exclude the owner's deferred startup maintenance from warm reload measurements.
const startupDeadline = Date.now() + 120_000;
while (
  !/startup (?:phase|trace): post-ready\.startup-maintenance \d/.test(readFileSync(logPath, "utf8"))
) {
  assert(Date.now() < startupDeadline, "Startup maintenance did not finish");
  await delay(25);
}
const inspector = new Session();
inspector.connect();
const samplingOptions = {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
};
const clients: InstanceType<typeof GatewayClient>[] = [];
let active = false;
const sessionKeys = new Map<InstanceType<typeof GatewayClient>, string>();
let configEvents = 0;
let sessionEvents = 0;
let modelInvalidations = 0;
const scopes: SessionRowChange["scope"][] = [];
const counts: Record<string, number> = {};
const automatic: Promise<unknown>[] = [];
const probeMs: number[] = [];
const errors: string[] = [];
const stopRows = sessionChanges.subscribe((change) => {
  if (active && "all" in change) {
    scopes.push(change.scope);
  }
});
const stopModels = registerPreparedModelRuntimePublicationListener((event) => {
  if (active && event.phase === "invalidated") {
    modelInvalidations++;
  }
});
const params = (client: InstanceType<typeof GatewayClient>, method: string) => {
  const key = sessionKeys.get(client)!;
  return method === "models.list"
    ? { agentId: "main", sessionKey: key, preparedOnly: true }
    : method === "session.members.listEvidence"
      ? { agentId: "main", sessionKey: key }
      : { agentId: "main", key };
};
async function probe(client: InstanceType<typeof GatewayClient>) {
  const start = performance.now();
  await client.request("models.list", params(client, "models.list"));
  probeMs.push(performance.now() - start);
}
function refetch(client: InstanceType<typeof GatewayClient>, method: string) {
  counts[method] = (counts[method] ?? 0) + 1;
  automatic.push(
    client
      .request(method, method === "config.get" ? {} : params(client, method))
      .catch((error: unknown) => {
        errors.push(String(error));
      }),
  );
}
async function drain() {
  let length = -1;
  while (length !== automatic.length) {
    length = automatic.length;
    await Promise.all(automatic);
    await delay(0);
  }
}
const results = [];
try {
  for (let index = 0; index < count; index++) {
    const ready = Promise.withResolvers<void>();
    const client = new GatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token,
      origin: `http://127.0.0.1:${port}`,
      clientName: "openclaw-control-ui",
      mode: "webchat",
      platform: "web",
      scopes: ["operator.admin"],
      requestTimeoutMs: 120_000,
      onHelloOk: () => ready.resolve(),
      onConnectError: (error) => ready.reject(error),
      onEvent: (event) => {
        if (!active) {
          return;
        }
        if (event.event === "config.changed") {
          configEvents++;
          refetch(client, "config.get");
          automatic.push(
            probe(client).catch((error: unknown) => {
              errors.push(String(error));
            }),
          );
        }
        if (event.event === "sessions.changed") {
          sessionEvents++;
        }
        if (
          isConversationConfigChange(event) ||
          (event.event === "sessions.changed" &&
            asNullableRecord(event.payload)?.reason === "profile-identity")
        ) {
          for (const method of [
            "session.members.listEvidence",
            "sessions.describe",
            "sessions.processes.list",
          ]) {
            refetch(client, method);
          }
        }
        if (modelCatalogEventInvalidation(event)) {
          refetch(client, "models.list");
        }
      },
    });
    clients.push(client);
    client.start();
    await ready.promise;
    await client.request("sessions.subscribe", {});
  }
  const roster = await clients[0]!.request<{ sessions: Array<{ key: string }> }>("sessions.list", {
    agentId: "main",
    limit: count,
  });
  assert.equal(roster.sessions.length, count, "Fixture needs one session per client");
  clients.forEach((client, index) => sessionKeys.set(client, roster.sessions[index]!.key));
  for (const client of clients) {
    for (const method of [
      "models.list",
      "session.members.listEvidence",
      "sessions.describe",
      "sessions.processes.list",
    ]) {
      await client.request(method, params(client, method));
    }
  }
  // Lazy reads can schedule full integrity verification after startupSettled.
  await databaseStartup.pendingPreparation;
  // The fixture's transcript pass runs independently of startup maintenance.
  let progress = "";
  let progressDeadline = Date.now() + 120_000;
  while (true) {
    const log = readFileSync(logPath, "utf8");
    if (log.includes("session: transcript facts backfill pass complete:")) {
      break;
    }
    const latest = log.match(/session: transcript facts backfill progress: [^"\n]+/g)?.at(-1);
    if (latest && latest !== progress) {
      progress = latest;
      progressDeadline = Date.now() + 120_000;
    }
    assert(Date.now() < progressDeadline, "Transcript backfill stopped making progress");
    await delay(1000);
  }
  if (values.allocations) {
    await inspector.post("HeapProfiler.startSampling", samplingOptions);
  }
  for (let warmup = 0; warmup < 2; warmup++) {
    const warmRevision = await clients[0]!.request<{ hash: string }>("config.get", {});
    await clients[0]!.request("config.patch", { baseHash: warmRevision.hash, raw: "{}" });
    await Promise.all(clients.map(probe));
  }
  if (values.allocations) {
    await inspector.post("HeapProfiler.stopSampling");
  }
  const owner = () =>
    getPublishedPreparedModelCatalogOwnerSnapshot({ agentId: "main", config: getRuntimeConfig() });
  const bursts = [
    ["control-1", { browser: { profiles: {} } }],
    ["control-2", { browser: { profiles: {} } }],
    // Compare model invalidation before browser writes can warm only the baseline's rebuilds.
    ["model", { agents: { defaults: { model: { primary: "fixture/second" } } } }],
    ["create", { browser: { profiles: { temporary: { cdpPort: 18801 } } } }],
    ["remove", { browser: { profiles: { temporary: null } } }],
    ["ui-prefs", { ui: { prefs: { chatShowToolCalls: false } } }],
    ["logging", { logging: { level: "debug" } }],
  ] as const;
  async function runBurst(label: string, patch: unknown, record = true) {
    await drain();
    const before = owner();
    const revision = await clients[0]!.request<{ hash: string }>("config.get", {});
    Object.keys(counts).forEach((method) => delete counts[method]);
    automatic.length = probeMs.length = scopes.length = errors.length = 0;
    configEvents = sessionEvents = modelInvalidations = 0;
    if (values.allocations) {
      await inspector.post("HeapProfiler.startSampling", samplingOptions);
    }
    if (record && values["cpu-profile"]) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    const cpu = process.threadCpuUsage();
    const totalCpu = process.cpuUsage();
    const start = performance.now();
    active = true;
    await clients[0]!.request("config.patch", {
      baseHash: revision.hash,
      raw: JSON.stringify(patch),
    });
    if (!label.startsWith("control")) {
      const deadline = Date.now() + 30_000;
      while (true) {
        if (configEvents >= count) {
          break;
        }
        assert(Date.now() < deadline, "Missing committed config events");
        await delay(5);
      }
    } else {
      await Promise.all(clients.map(probe));
    }
    await drain();
    active = false;
    const wallMs = performance.now() - start;
    const thread = process.threadCpuUsage(cpu);
    const processCpu = process.cpuUsage(totalCpu);
    let allocationBytes;
    if (values.allocations) {
      const { profile } = await inspector.post("HeapProfiler.stopSampling");
      allocationBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    }
    if (record && values["cpu-profile"]) {
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(`${values.output}.${label}.cpuprofile`, JSON.stringify(profile), {
        flag: "wx",
      });
    }
    const retainedRuntime = before?.isCurrent === owner()?.isCurrent;
    assert.equal(
      retainedRuntime,
      !label.startsWith("model"),
      `Unexpected runtime replacement for ${label}`,
    );
    assert.deepEqual(errors, []);
    return {
      label,
      wallMs,
      cpuMs: (thread.user + thread.system) / 1000,
      processCpuMs: (processCpu.user + processCpu.system) / 1000,
      allocationBytes,
      retainedRuntime,
      modelInvalidations,
      configEvents,
      sessionEvents,
      scopes: [...scopes],
      refetches: { ...counts },
      modelsProbeMs: [...probeMs],
    };
  }
  const resetModel = { agents: { defaults: { model: { primary: "fixture/first" } } } };
  // Exercise the real callbacks and all read/write worker classes before timing.
  for (const [label, patch] of bursts) {
    await runBurst(label, patch, false);
  }
  await runBurst("model-reset", resetModel, false);
  await runBurst("ui-reset", { ui: { prefs: { chatShowToolCalls: true } } }, false);
  await runBurst("logging-reset", { logging: { level: "info" } }, false);
  const measuredStartLoad = loadavg();
  assert(measuredStartLoad[0]! < 8, "Warmed arm must start below 8 one-minute load");
  if (values["controls-only"]) {
    for (const [label, patch] of bursts.slice(0, 3)) {
      results.push(await runBurst(label, patch));
    }
    await runBurst("model-reset", resetModel, false);
    results.push(await runBurst("model-repeat", bursts[2][1]));
  } else {
    for (const [label, patch] of bursts) {
      results.push(await runBurst(label, patch));
    }
  }
  if (values["baseline-dir"]) {
    assert(
      replaced.every((check) => check()),
      "Baseline owners were not loaded",
    );
  }
  writeFileSync(
    values.output,
    JSON.stringify(
      {
        variant: values["baseline-dir"] ? "baseline" : "candidate",
        node: process.version,
        load: loadavg(),
        startLoad,
        measuredStartLoad,
        warmedControls: true,
        clients: count,
        distinctSessions: new Set(sessionKeys.values()).size,
        fixture,
        results,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log(JSON.stringify(results));
} finally {
  active = false;
  stopRows();
  stopModels();
  inspector.disconnect();
  for (const client of clients) {
    client.stop();
  }
  await server.close({ reason: "Synthetic config reload proof complete" });
}
