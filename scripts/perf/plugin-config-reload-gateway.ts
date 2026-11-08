/**
 * Actual Gateway + config.patch + retained agent turns; all state and HTTP peers are synthetic.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/plugin-config-reload-gateway.ts \
 *   --root <new-dir> --baseline <visitor-plugin-dir> --candidate <visitor-plugin-dir> --team-shape
 * Acceptance: candidate numeric edits retain the instance, serve readyz=200 and new turns,
 * expose the new limit before old turns finish, and never signal a restart. Explicit generation reload must
 * still wait for old turns, then publish a replacement; it does not prove bundled export refresh. Baseline/candidate alternate (5 each);
 * unchanged config writes are A/A controls. Candidate median/p95 CPU and allocation must
 * not regress by over 20% against baseline; report controls separately. CPU is process CPU; allocation is sampled V8 bytes
 * including collected objects on the Gateway main isolate, not RSS or total worker allocation.
 * The deterministic localhost model exercises the real agent transport, not a live vendor model.
 * --team-shape reuses the offline fixture: 5,000 sessions, 64 MiB transcripts and 62,000
 * real 18 KB workspace files. It does not claim a 35 GiB database or btrfs equivalence.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    baseline: { type: "string" },
    candidate: { type: "string" },
    runs: { type: "string", default: "5" },
    variant: { type: "string" },
    fixture: { type: "string" },
    turns: { type: "string", default: "11" },
    "team-shape": { type: "boolean", default: false },
    "candidate-only": { type: "boolean", default: false },
  },
});
assert(
  values.root && values.baseline && values.candidate,
  "Provide --root, --baseline, --candidate",
);
const sources = { baseline: values.baseline, candidate: values.candidate };
const root = path.resolve(values.root);
const runs = Number(values.runs);
const turnCount = Number(values.turns);
assert(Number.isInteger(runs) && runs > 0 && runs <= 10);
assert(Number.isInteger(turnCount) && turnCount > 0 && turnCount <= 32);
const sampleVariant = values.variant;
if (!sampleVariant) {
  if (values["team-shape"] && !values.fixture) {
    const { generateTeamShapeFixture, parseTeamShapeOptions } =
      await import("./team-shape-fixture.ts");
    await generateTeamShapeFixture(
      parseTeamShapeOptions([
        "--state-dir",
        root,
        "--sessions",
        "5000",
        "--runs",
        "0",
        "--approvals",
        "0",
        "--cron",
        "0",
        "--projects",
        "1",
        "--worktree-files",
        "62000",
        "--worktree-file-bytes",
        "18000",
      ]),
    );
  } else {
    mkdirSync(root);
  }
  mkdirSync(path.join(root, "samples"));
  const results = [];
  // Bundled native modules have immutable process identity; every source variant needs a new host.
  for (let run = 0; run < runs; run++) {
    for (const variant of values["candidate-only"] ? ["candidate"] : ["baseline", "candidate"]) {
      const sampleRoot = path.join(root, "samples", `${run}-${variant}`);
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [
            ...process.execArgv,
            process.argv[1]!,
            "--root",
            sampleRoot,
            "--baseline",
            sources.baseline,
            "--candidate",
            sources.candidate,
            "--runs",
            "1",
            "--turns",
            String(turnCount),
            "--variant",
            variant,
            ...(values.fixture || values["team-shape"]
              ? ["--fixture", values.fixture ?? root]
              : []),
          ],
          { stdio: "inherit" },
        );
        child.once("error", reject);
        child.once("exit", (code, signal) =>
          code === 0
            ? resolve()
            : reject(new Error(`Gateway sample ${run}/${variant} failed: ${code ?? signal}`)),
        );
      });
      const [sample] = JSON.parse(
        readFileSync(path.join(sampleRoot, "results.json"), "utf8"),
      ) as Array<{ variant: string; run: number }>;
      assert(sample);
      assert.equal(sample.variant, variant);
      sample.run = run;
      results.push(sample);
      writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
    }
  }
  process.exit(0);
}
assert(sampleVariant === "baseline" || sampleVariant === "candidate");
mkdirSync(root);
for (const name of ["home", "workspace", "tmp"]) {
  mkdirSync(path.join(root, name));
}
if (values.fixture) {
  // Clone the session corpus; shared state/client custody initializes independently in each host.
  cpSync(path.join(values.fixture, "agents"), path.join(root, "agents"), {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
}
// Bundled trust requires physical package containment, even for isolated proof sources.
const bundledRoot = path.resolve("dist/extensions", `.plugin-config-proof-${randomUUID()}`);
const pluginRoot = path.join(bundledRoot, "visitor-access");
cpSync(path.resolve(sources[sampleVariant]), pluginRoot, {
  recursive: true,
  filter: (entry) => path.basename(entry) !== "node_modules",
});
symlinkSync(path.resolve("node_modules"), path.join(pluginRoot, "node_modules"), "dir");
const configPath = path.join(root, "openclaw.json");
const port = await getFreePort();
const token = "synthetic-plugin-config-proof";
process.env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
    TMPDIR: path.join(root, "tmp"),
  },
});
const originalFetch = globalThis.fetch;
let policyReads = 0;
globalThis.fetch = (input, init) => {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.origin !== "https://api.cloudflare.com") {
    return originalFetch(input, init);
  }
  assert.equal(init?.method, "GET", "Proof must not mutate a provider policy");
  policyReads++;
  const policy = {
    id: "fixture-policy",
    name: "Visitors (openclaw-managed)",
    decision: "allow",
    include: ["one", "two", "three"].map((name) => ({ email: { email: `${name}@example.test` } })),
    exclude: [],
    require: [],
  };
  return Promise.resolve(Response.json({ success: true, result: url.search ? [policy] : policy }));
};
const holds = new Map<
  string,
  {
    entered: ReturnType<typeof Promise.withResolvers<void>>;
    release: ReturnType<typeof Promise.withResolvers<void>>;
  }
>();
const lists = new Map<string, unknown>();
const model = await startOpenAiResponsesModelServer({
  modelId: "plugin-config-proof",
  bindError: "Synthetic model failed to bind",
  async onRequest(request, response) {
    let raw = "";
    for await (const chunk of request) {
      raw += String(chunk);
    }
    const body = JSON.parse(raw) as {
      input?: Array<{
        type?: string;
        role?: string;
        name?: string;
        call_id?: string;
        output?: string;
      }>;
    };
    const key = [...holds.keys()].find((candidate) => raw.includes(candidate));
    const call = body.input?.findLast(
      (item) => item.type === "function_call" && item.name === "visitor_list",
    );
    const output =
      call &&
      body.input?.find(
        (item) => item.type === "function_call_output" && item.call_id === call.call_id,
      )?.output;
    if (!call) {
      writeToolCall(response, "visitor_list", {});
      return;
    }
    if (key) {
      lists.set(key, output);
      holds.get(key)!.entered.resolve();
      await holds.get(key)!.release.promise;
    }
    writeOpenAiResponsesText(response, {
      text: "Synthetic visitor check complete.",
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
    modelId: "plugin-config-proof",
    reasoning: false,
    toolProfile: "full",
  }),
  logging: { file: path.join(root, "gateway.log") },
  gateway: {
    ...BASE_GATEWAY_BENCH_CONFIG.gateway,
    auth: { mode: "token" as const, token },
    controlUi: { enabled: false, allowedOrigins: [`http://127.0.0.1:${port}`] },
  },
  agents: {
    defaults: {
      skipBootstrap: true,
      skills: [],
      maxConcurrent: 32,
      model: { primary: "proof/plugin-config-proof" },
      models: { "proof/plugin-config-proof": { agentRuntime: { id: "openclaw" } } },
    },
    entries: {
      main: {
        workspace: values.fixture
          ? path.join(values.fixture, "fixture-worktrees", "team-shape-project-0")
          : path.join(root, "workspace"),
      },
    },
  },
  tools: { profile: "full" as const, codeMode: false, toolSearch: false },
  skills: { load: { watch: false } },
  cron: { enabled: false },
  plugins: {
    enabled: true,
    allow: ["visitor-access"],
    slots: { memory: "none" },
    entries: {
      "visitor-access": {
        enabled: true,
        config: {
          accountId: "fixture-account",
          appId: "fixture-app",
          apiToken: "synthetic-token",
          maxVisitors: 1,
        },
      },
    },
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
await resolvePluginCapabilityConsent({
  config: cfg,
  pluginId: "visitor-access",
  env: process.env,
  acknowledge: {
    reviewToken: computeDeclaredSurfaceHash(
      resolvePluginArtifactDeclaredSurface(pluginRoot, process.env, { config: cfg }),
    ),
  },
});
const { startGatewayServer } = await import("../../src/gateway/server.js");
const { GatewayClient } = await import("../../src/gateway/client.js");
const { getActivePluginRegistry } = await import("../../src/plugins/runtime.js");
const { getPluginInstance } = await import("../../src/plugins/plugin-instance-scope.js");
const { getRuntimeConfig } = await import("../../src/config/io.js");
const { withPluginLifecycleLeaseAsync } =
  await import("../../src/plugins/plugin-lifecycle-lease.js");
const { requestGatewayRestartWithSignalAdmission } = await import("../../src/infra/restart.js");
let restarts = 0;
const restarted = () => {
  restarts++;
};
process.on("SIGUSR2", restarted);
const server = await startGatewayServer(port, {
  bind: "loopback",
  controlUiEnabled: false,
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
const inspector = new Session();
inspector.connect();
const rows: unknown[] = [];
function instance() {
  const record = getActivePluginRegistry()?.plugins.find((entry) => entry.id === "visitor-access");
  assert(record, "Visitor Access must be active");
  assert.equal(record.origin, "bundled");
  assert.equal(record.rootDir, pluginRoot, "Proof must load the staged source variant");
  const value = getPluginInstance(record);
  assert(value);
  return value;
}
async function until(predicate: () => boolean, message: string, timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (!predicate()) {
    assert(Date.now() < deadline, message);
    await delay(25);
  }
}
async function patch(maxVisitors: number) {
  const snapshot = await client.request<{ hash: string }>("config.get", {});
  return client.request("config.patch", {
    baseHash: snapshot.hash,
    raw: JSON.stringify({
      plugins: { entries: { "visitor-access": { config: { maxVisitors } } } },
    }),
  });
}
async function measure(change: () => Promise<unknown>) {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 32768,
    includeObjectsCollectedByMajorGC: true,
    includeObjectsCollectedByMinorGC: true,
  });
  const cpu = process.cpuUsage();
  const startTimeUs = Number(process.hrtime.bigint() / 1000n);
  const start = performance.now();
  let error: string | undefined;
  try {
    await change();
  } catch (cause) {
    error = String(cause);
  }
  const elapsedMs = performance.now() - start;
  const endTimeUs = Number(process.hrtime.bigint() / 1000n);
  const cpuDelta = process.cpuUsage(cpu);
  const allocation = await inspector.post("HeapProfiler.stopSampling");
  return {
    error,
    startTimeUs,
    endTimeUs,
    elapsedMs,
    cpuMs: (cpuDelta.user + cpuDelta.system) / 1000,
    allocatedBytes: allocation.profile.samples.reduce((sum, sample) => sum + sample.size, 0),
  };
}
async function heldTurn(label: string) {
  const marker = `${label}-${randomUUID()}`;
  const gates = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() };
  holds.set(marker, gates);
  const runId = randomUUID();
  await client.request("chat.send", {
    sessionKey: `agent:main:proof:${marker}`,
    message: `Run visitor_list once. ${marker}`,
    idempotencyKey: runId,
    deliver: false,
  });
  await Promise.race([
    gates.entered.promise,
    delay(90_000, undefined, { ref: false }).then(() => {
      throw new Error(`Turn failed to enter model hold: ${marker}`);
    }),
  ]);
  return { marker, runId, release: () => gates.release.resolve() };
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
try {
  // Normalize the first persisted source before warm A/A and A/B samples.
  await patch(2);
  await patch(1);
  await join([await heldTurn("warmup")]);
  const variant = sampleVariant;
  await withPluginLifecycleLeaseAsync({}, async () => {});
  await patch(1);
  // Two identical no-op writes establish A/A overhead without plugin replacement.
  const controls = [];
  for (let control = 0; control < 2; control++) {
    const unchanged = await measure(() => patch(1));
    assert.equal(unchanged.error, undefined, "A/A control must succeed");
    controls.push(unchanged);
  }
  const turns = await Promise.all(Array.from({ length: turnCount }, () => heldTurn(variant)));
  for (const turn of turns) {
    assert(
      String(lists.get(turn.marker)).includes("2 entries omitted"),
      "Initial visitor_list must succeed with the old limit",
    );
  }
  const previous = instance();
  const retained = previous.retentionSnapshot().total;
  assert(retained > 0, "Real turns must retain Visitor Access");
  const probes: number[] = [];
  const polling = new AbortController();
  const poll = (async () => {
    while (!polling.signal.aborted) {
      const res = await originalFetch(`http://127.0.0.1:${port}/readyz`);
      probes.push(res.status);
      await delay(100);
    }
  })();
  const restartBefore = restarts;
  const measurement = await measure(() => patch(2));
  const { error } = measurement;
  polling.abort();
  await poll;
  const sameInstance = instance() === previous;
  const activeLimit = getRuntimeConfig().plugins?.entries?.["visitor-access"]?.config?.maxVisitors;
  assert.equal(restarts, restartBefore, "Config-only reload must not emit a Gateway restart");
  let newTurnMs: number | undefined;
  let effectiveList: unknown;
  if (variant === "candidate") {
    assert.equal(error, undefined);
    assert(sameInstance);
    assert.equal(activeLimit, 2);
    assert(probes.every((code) => code === 200));
    const nextStart = performance.now();
    const next = await heldTurn("new-run");
    newTurnMs = performance.now() - nextStart;
    effectiveList = lists.get(next.marker);
    assert(
      String(effectiveList).includes("1 entries omitted"),
      "New limit must show two of three visitors",
    );
    await join([next]);
  } else {
    assert(error, "Baseline must fail its bounded drain while the turns stay held");
    assert(probes.includes(503));
  }
  await join(turns);
  await until(
    () => getRuntimeConfig().plugins?.entries?.["visitor-access"]?.config?.maxVisitors === 2,
    "Deferred config did not apply",
  );
  await withPluginLifecycleLeaseAsync({}, async () => {});
  const row = {
    variant,
    run: 0,
    retained,
    ...measurement,
    controls,
    readyz: { count: probes.length, failures: probes.filter((code) => code !== 200).length },
    sameInstance,
    activeLimit,
    error,
    newTurnMs,
    effectiveList,
    restarts: restarts - restartBefore,
    policyReads,
    hostLoad: loadavg(),
  };
  rows.push(row);
  console.log("PLUGIN_CONFIG_SAMPLE", JSON.stringify(row));
  writeFileSync(path.join(root, "results.json"), JSON.stringify(rows, null, 2));
  const turn = await heldTurn("generation-reload");
  const old = instance();
  let settled = false;
  const reload = client
    .request("plugins.reload", { plugins: [{ pluginId: "visitor-access" }] })
    .then((value) => {
      settled = true;
      return value;
    });
  await until(() => old.replacementPending, "Generation replacement never entered its drain");
  assert(!settled, "Generation replacement must retain old work");
  await join([turn]);
  await reload;
  assert.notEqual(instance(), old);
  assert.equal(
    restarts,
    0,
    "Neither config updates nor generation replacement may restart the Gateway",
  );
  console.log(
    "PLUGIN_GENERATION_REPLACEMENT",
    JSON.stringify({ waitedForTurn: true, replaced: true, restarts }),
  );
} finally {
  for (const gate of holds.values()) {
    gate.release.resolve();
  }
  inspector.disconnect();
  client.stop();
  process.off("SIGUSR2", restarted);
  await server.close({ reason: "synthetic plugin config proof complete" });
  rmSync(bundledRoot, { recursive: true, force: true });
  await model.close();
  globalThis.fetch = originalFetch;
}
