/** Real Gateway config saves during unrelated and plugin-using turns. Synthetic data only.
 * Run each pinned checkout with --root <new-dir> --arm baseline|candidate.
 * --serve keeps the same fixture alive for a Control UI edit; release via its local control URL.
 * Acceptance: unused-plugin work=0, deferred save <5s, no readyz failures or >5s unrelated
 * admission; after the holder ends, revision 2 applies. Compare five interleaved fresh-process
 * arms and unchanged-write A/A controls. CPU includes all process threads; allocation samples
 * cover the main isolate, including collected objects. No btrfs/35GiB storage claim.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { constants, cpSync, mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { Session } from "node:inspector/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { writeToolCall } from "../../src/gateway/gateway-provider-fixture.test-support.js";
import {
  createOpenAiResponsesModelConfig,
  startOpenAiResponsesModelServer,
} from "../../test/helpers/openai-responses-model-fixture.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { getFreePort } from "../lib/gateway-bench-probes.ts";
import { BASE_GATEWAY_BENCH_CONFIG, createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";

const { values } = parseArgs({
  options: {
    root: { type: "string" },
    arm: { type: "string", default: "candidate" },
    serve: { type: "boolean", default: false },
    "ui-root": { type: "string" },
    turns: { type: "string", default: "10" },
    plugins: { type: "string", default: "40" },
    fixture: { type: "string" },
    profile: { type: "boolean", default: false },
  },
});
assert(values.root && ["baseline", "candidate"].includes(values.arm));
const root = path.resolve(values.root);
const turnCount = Number(values.turns);
const pluginCount = Number(values.plugins);
assert(Number.isSafeInteger(turnCount) && turnCount > 0 && turnCount < 24);
assert(Number.isSafeInteger(pluginCount) && pluginCount > 1 && pluginCount <= 100);
mkdirSync(root);
for (const name of ["home", "workspace", "tmp", "plugins"]) {
  mkdirSync(path.join(root, name));
}
if (values.fixture) {
  cpSync(path.join(values.fixture, "agents"), path.join(root, "agents"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}
const workspace = values.fixture
  ? path.join(values.fixture, "fixture-worktrees", "team-shape-project-0")
  : path.join(root, "workspace");
const configPath = path.join(root, "openclaw.json");
const port = await getFreePort();
const token = "synthetic-reload-admission-proof";
process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    TMPDIR: path.join(root, "tmp"),
  },
});
const pluginIds = Array.from({ length: pluginCount }, (_, i) =>
  i === 0 ? "reload-proof" : `unused-proof-${i}`,
);
for (const id of pluginIds) {
  const dir = path.join(root, "plugins", id);
  mkdirSync(dir);
  writeFileSync(
    path.join(dir, "openclaw.plugin.json"),
    JSON.stringify({
      id,
      name: id === "reload-proof" ? "Reload proof" : id,
      activation: { onStartup: true },
      ...(id === "reload-proof"
        ? {
            contracts: { tools: ["reload_probe"] },
            toolMetadata: { reload_probe: { optional: true } },
          }
        : {}),
      configSchema: {
        type: "object",
        properties: { revision: { type: "integer", minimum: 1 } },
        additionalProperties: false,
      },
      uiHints: {
        revision: {
          label: "Revision",
          help: "Synthetic config revision used by this plugin generation.",
        },
      },
    }),
  );
  writeFileSync(
    path.join(dir, "index.cjs"),
    id === "reload-proof"
      ? `module.exports = { id: "reload-proof", register(api) {
    const revision = api.pluginConfig.revision;
    api.registerTool({name:"reload_probe", label:"Reload probe",description:"Read the synthetic plugin revision",parameters:{type:"object",properties:{}},
      async execute() { return { content:[{type:"text",text:JSON.stringify({revision})}],details:{revision} }; }
    }, {optional:true});
  }};`
      : `module.exports = { id: ${JSON.stringify(id)}, register() {} };`,
  );
}
const holds = new Map<
  string,
  {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
    related: boolean;
    output?: string;
  }
>();
const model = await startOpenAiResponsesModelServer({
  modelId: "reload-proof",
  bindError: "Local model bind failed",
  async onRequest(request, response) {
    let raw = "";
    for await (const chunk of request) {
      raw += String(chunk);
    }
    const marker = [...holds.keys()].find((key) => raw.includes(key));
    const hold = marker ? holds.get(marker) : undefined;
    const body = JSON.parse(raw) as {
      input?: Array<{ type?: string; name?: string; call_id?: string; output?: string }>;
    };
    const call = body.input?.findLast(
      (item) => item.type === "function_call" && item.name === "reload_probe",
    );
    if (hold?.related && !call) {
      writeToolCall(response, "reload_probe", {});
      return;
    }
    if (hold) {
      hold.output = body.input?.find(
        (item) => item.type === "function_call_output" && item.call_id === call?.call_id,
      )?.output;
      hold.entered.resolve();
      await hold.release.promise;
    }
    writeOpenAiResponsesText(response, {
      text: "Synthetic turn complete.",
      messageId: randomUUID(),
      responseId: randomUUID(),
    });
  },
});
const cfg = {
  ...BASE_GATEWAY_BENCH_CONFIG,
  ...createOpenAiResponsesModelConfig({
    baseUrl: model.baseUrl,
    providerId: "proof",
    modelId: "reload-proof",
    reasoning: false,
    toolProfile: "full",
  }),
  logging: { file: path.join(root, "gateway.log") },
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    auth: { mode: "token" as const, token },
    controlUi: {
      enabled: values.serve,
      ...(values["ui-root"] ? { root: path.resolve(values["ui-root"]) } : {}),
      allowedOrigins: [`http://127.0.0.1:${port}`],
    },
  },
  agents: {
    ownership: "explicit" as const,
    defaults: {
      systemAgent: { agentId: "main" },
      skipBootstrap: true,
      skills: [],
      maxConcurrent: 32,
      model: { primary: "proof/reload-proof" },
      models: { "proof/reload-proof": { agentRuntime: { id: "openclaw" } } },
    },
    entries: {
      main: { workspace, tools: { alsoAllow: ["reload_probe"] } },
      reader: { workspace, tools: { deny: ["reload_probe"] } },
    },
  },
  tools: { profile: "full" as const, codeMode: false, toolSearch: false },
  skills: { load: { watch: false } },
  cron: { enabled: false },
  plugins: {
    enabled: true,
    allow: pluginIds,
    load: { paths: [path.join(root, "plugins")] },
    slots: { memory: "none" },
    entries: Object.fromEntries(
      pluginIds.map((id) => [id, { enabled: true, config: { revision: 1 } }]),
    ),
  },
};
writeFileSync(configPath, JSON.stringify(cfg));
const { refreshPersistedInstalledPluginIndex } =
  await import("../../src/plugins/installed-plugin-index-store-write.js");
await refreshPersistedInstalledPluginIndex({
  reason: "source-changed",
  config: cfg,
  env: process.env,
  installRecords: {},
});
const { resolvePluginArtifactDeclaredSurface } =
  await import("../../src/plugins/capability-artifact.js");
const { computeDeclaredSurfaceHash } = await import("../../src/plugins/capability-summary.js");
const { resolvePluginCapabilityConsent } = await import("../../src/plugins/capability-consent.js");
for (const id of pluginIds) {
  await resolvePluginCapabilityConsent({
    config: cfg,
    pluginId: id,
    env: process.env,
    acknowledge: {
      reviewToken: computeDeclaredSurfaceHash(
        resolvePluginArtifactDeclaredSurface(path.join(root, "plugins", id), process.env, {
          config: cfg,
        }),
      ),
    },
  });
}
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const { getActivePluginRegistry } = await import("../../src/plugins/runtime.js");
const { getPluginInstance } = await import("../../src/plugins/plugin-instance-scope.js");
const { getRuntimeConfig } = await import("../../src/config/io.js");
const { requestGatewayRestartWithSignalAdmission } = await import("../../src/infra/restart.js");
const server = await startGatewayServer(port, {
  bind: "loopback",
  controlUiEnabled: values.serve,
  hotReloadRecovery: requestGatewayRestartWithSignalAdmission,
});
await server.startupSettled;
const hello = Promise.withResolvers<void>();
const client = new GatewayClient({
  url: `ws://127.0.0.1:${port}`,
  token,
  origin: `http://127.0.0.1:${port}`,
  clientName: "openclaw-control-ui",
  mode: "webchat",
  platform: "web",
  scopes: ["operator.admin"],
  requestTimeoutMs: 150_000,
  onHelloOk: () => hello.resolve(),
  onConnectError: (error) => hello.reject(error),
});
client.start();
await hello.promise;
const instance = (id = "reload-proof") => {
  const record = getActivePluginRegistry()?.plugins.find((entry) => entry.id === id);
  assert(record, `Missing ${id}`);
  const value = getPluginInstance(record);
  assert(value, `Missing instance ${id}`);
  return value;
};
async function until(predicate: () => boolean, message: string, timeout = 150_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await delay(25);
  }
}
async function patch(revision: number) {
  const snapshot = await client.request<{ hash: string }>("config.get", {});
  return client.request("config.patch", {
    baseHash: snapshot.hash,
    raw: JSON.stringify({ plugins: { entries: { "reload-proof": { config: { revision } } } } }),
  });
}
async function heldTurn(related: boolean) {
  const marker = randomUUID();
  const hold = {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    related,
  };
  holds.set(marker, hold);
  const runId = randomUUID();
  await client.request("chat.send", {
    sessionKey: `agent:${related ? "main" : "reader"}:proof:${marker}`,
    message: `${related ? "Run reload_probe once." : "Answer without calling tools."} ${marker}`,
    idempotencyKey: runId,
    deliver: false,
  });
  await Promise.race([
    hold.entered.promise,
    delay(150_000, undefined, { ref: false }).then(() => {
      throw new Error("Turn never reached local model hold");
    }),
  ]);
  return { runId, marker, release: () => hold.release.resolve() };
}
async function join(turns: Awaited<ReturnType<typeof heldTurn>>[]) {
  for (const turn of turns) {
    turn.release();
  }
  for (const turn of turns) {
    const result = await client.request<{ status: string }>("agent.wait", {
      runId: turn.runId,
      timeoutMs: 90_000,
    });
    assert.equal(result.status, "ok");
    holds.delete(turn.marker);
  }
}
const inspector = new Session();
inspector.connect();
async function measure(run: () => Promise<unknown>) {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpu = process.cpuUsage();
  const start = performance.now();
  let outcome: { ok: true } | { ok: false; message: string; details?: unknown };
  try {
    await run();
    outcome = { ok: true };
  } catch (error) {
    const details = error instanceof Error && "details" in error ? error.details : undefined;
    outcome = {
      ok: false,
      message: String(error),
      details:
        details && typeof details === "object" && "application" in details
          ? { application: details.application, persistedConfig: "persistedConfig" in details }
          : undefined,
    };
  }
  const elapsedMs = performance.now() - start;
  const cpuDelta = process.cpuUsage(cpu);
  const allocation = await inspector.post("HeapProfiler.stopSampling");
  return {
    outcome,
    elapsedMs,
    cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
    allocatedBytes: allocation.profile.samples.reduce((sum, sample) => sum + sample.size, 0),
  };
}
let turns: Awaited<ReturnType<typeof heldTurn>>[] = [];
try {
  const controls = [await measure(() => patch(1)), await measure(() => patch(1))];
  for (let i = 0; i < turnCount; i++) {
    turns.push(await heldTurn(false));
  }
  const unrelatedCounts = {
    target: instance().retainedWorkCount,
    empty: instance("unused-proof-1").retainedWorkCount,
  };
  turns.push(await heldTurn(true));
  const counts = {
    target: instance().retainedWorkCount,
    empty: instance("unused-proof-1").retainedWorkCount,
  };
  assert(
    String(holds.get(turns.at(-1)!.marker)?.output).includes('"revision":1'),
    `Real plugin call must observe revision 1: ${holds.get(turns.at(-1)!.marker)?.output}`,
  );
  if (values.serve) {
    const stopped = Promise.withResolvers<void>();
    const control = createServer((request, response) => {
      if (request.url === "/release") {
        for (const turn of turns) {
          turn.release();
        }
      }
      if (request.url === "/stop") {
        stopped.resolve();
      }
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          revision: getRuntimeConfig().plugins?.entries?.["reload-proof"]?.config?.revision,
          unrelatedCounts,
          counts,
          current: instance().retainedWorkCount,
        }),
      );
    });
    await new Promise<void>((resolve) => {
      control.listen(0, "127.0.0.1", resolve);
    });
    const address = control.address();
    assert(address && typeof address !== "string");
    const info = {
      url: `http://127.0.0.1:${port}`,
      token,
      controlUrl: `http://127.0.0.1:${address.port}`,
      root,
      unrelatedCounts,
      counts,
    };
    writeFileSync(path.join(root, "fixture.json"), JSON.stringify(info, null, 2));
    console.log("FIXTURE_READY", JSON.stringify(info));
    process.once("SIGTERM", () => stopped.resolve());
    process.once("SIGINT", () => stopped.resolve());
    await stopped.promise;
    control.closeAllConnections();
    await new Promise<void>((resolve) => {
      control.close(() => resolve());
    });
  } else {
    const probes: number[] = [];
    const polling = new AbortController();
    const poll = (async () => {
      while (!polling.signal.aborted) {
        probes.push((await fetch(`http://127.0.0.1:${port}/readyz`)).status);
        await delay(100);
      }
    })();
    const previous = instance();
    let patched = false;
    if (values.profile) {
      await inspector.post("Profiler.enable");
      await inspector.post("Profiler.start");
    }
    const measurement = measure(() => patch(2)).finally(() => {
      patched = true;
    });
    await until(() => patched || previous.replacementPending, "No replacement or receipt");
    const admissionStart = performance.now();
    const next = await heldTurn(false);
    const admissionMs = performance.now() - admissionStart;
    await join([next]);
    const saved = await measurement;
    if (values.profile) {
      const { profile } = await inspector.post("Profiler.stop");
      writeFileSync(path.join(root, "reload.cpuprofile"), JSON.stringify(profile));
    }
    for (let i = 0; i < 3; i++) {
      await join([await heldTurn(false)]);
    }
    polling.abort();
    await poll;
    const savedRevision = getRuntimeConfig().plugins?.entries?.["reload-proof"]?.config?.revision;
    const releasedAt = performance.now();
    await join(turns);
    turns = [];
    await until(
      () => getRuntimeConfig().plugins?.entries?.["reload-proof"]?.config?.revision === 2,
      "Saved revision did not eventually apply",
    );
    const appliedAfterReleaseMs = performance.now() - releasedAt;
    const appliedTurn = await heldTurn(true);
    assert(
      String(holds.get(appliedTurn.marker)?.output).includes('"revision":2'),
      "The replacement plugin must serve the saved revision",
    );
    await join([appliedTurn]);
    const row = {
      arm: values.arm,
      nodeVersion: process.version,
      pluginCount,
      turnCount,
      unrelatedCounts,
      counts,
      controls,
      ...saved,
      admissionMs,
      savedRevision,
      appliedAfterReleaseMs,
      readyz: { samples: probes.length, failures: probes.filter((code) => code !== 200).length },
      hostLoad: loadavg(),
    };
    writeFileSync(path.join(root, "result.json"), JSON.stringify(row, null, 2));
    console.log("RELOAD_ADMISSION_SAMPLE", JSON.stringify(row));
    if (values.arm === "candidate") {
      assert.equal(unrelatedCounts.empty, 0);
      assert.equal(unrelatedCounts.target, 0);
      assert.equal(savedRevision, 1);
      assert.equal(saved.outcome.ok, false);
      assert(!saved.outcome.ok && saved.outcome.message.includes("saved but deferred"));
      if (!saved.outcome.ok) {
        const details = saved.outcome.details;
        assert(details && typeof details === "object" && "application" in details);
        const application = details.application;
        assert(application && typeof application === "object" && "status" in application);
        assert.equal(application.status, "deferred");
      }
      assert(saved.elapsedMs < 5000);
      assert(admissionMs < 5000);
      assert(probes.every((code) => code === 200));
    }
  }
} finally {
  for (const hold of holds.values()) {
    hold.release.resolve();
  }
  if (turns.length) {
    await join(turns).catch(() => {});
  }
  inspector.disconnect();
  client.stop();
  await server.close({ reason: "synthetic reload proof finished" });
  await model.close();
}
