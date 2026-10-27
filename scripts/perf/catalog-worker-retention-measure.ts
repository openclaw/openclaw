/**
 * Synthetic catalog-worker retention, with forced GC outside request timing windows.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/catalog-worker-retention-measure.ts
 *   --output /absolute/new-fixture --workspaces 5 --models 5000 --runtime-plugin [--snapshot]
 * Alternate independent baseline/candidate launches; --owner-dir substitutes pinned source files.
 * Add --idle-seconds 600 for an allocation/GC profile after catalog tasks settle, with
 * production worker diagnostics enabled and memory requests every 30 seconds. No forced GC
 * occurs inside that window. The preload's sampling/polling overhead is present in both arms.
 * Source-mode heap includes the TypeScript loader; do not equate it with packaged Gateway RSS.
 * --task-rounds 20 --measure-tasks profiles tasks after the first cold request. Add
 * --sample-allocation for a separate allocation pass; omit it for timing measurements.
 * --duration-seconds 600 --refresh-seconds 30 --active-workspaces 2 --providers 4
 * runs periodic remote revisions after warming every workspace; the other workspaces go idle.
 * Timed mode publishes revision zero before worker creation, matching the inherited startup
 * catalog retained alongside workspace revisions in a running Gateway.
 * Each workspace has a distinct plugin config and synthetic account per provider. Discovery
 * uses the public SDK TTL cache, with --discovery-models rows per provider/account. Run with
 * --runtime-plugin. Timing and allocation passes use the same workload; --snapshot captures
 * the settled final heap after the measured window, never during it. Diagnostic owner censuses
 * are sampled every 30 seconds; their sampleAgeMs records asynchronous collection freshness.
 * This exercises a real catalog worker, not a complete Gateway or its client workload.
 * --built-worker /path/to/build uses an already-built dist worker with the native stress
 * loader, excluding TypeScript transform caches from the worker heap. Build before running.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import workerThreads from "node:worker_threads";
import { prepareModelCatalogWorkerContext } from "../../src/agents/prepared-model-catalog-fingerprints.js";
import type {
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "../../src/agents/prepared-model-catalog-worker.types.js";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    workspaces: { type: "string", default: "20" },
    models: { type: "string", default: "5000" },
    "owner-dir": { type: "string" },
    snapshot: { type: "boolean", default: false },
    "built-worker": { type: "string" },
    "runtime-plugin": { type: "boolean", default: false },
    "idle-seconds": { type: "string", default: "0" },
    "duration-seconds": { type: "string", default: "0" },
    "refresh-seconds": { type: "string", default: "30" },
    "active-workspaces": { type: "string" },
    providers: { type: "string", default: "1" },
    "discovery-models": { type: "string", default: "500" },
    "task-rounds": { type: "string", default: "2" },
    "measure-tasks": { type: "boolean", default: false },
    "sample-allocation": { type: "boolean", default: false },
  },
});
assert(values.output, "--output must name a new synthetic fixture directory");
const root = path.resolve(values.output);
assert(!fs.existsSync(root), "Refusing to reuse an existing fixture directory");
const rows = Number(values.models);
const workspaces = Number(values.workspaces);
const idleSeconds = Number(values["idle-seconds"]);
const taskRounds = Number(values["task-rounds"]);
const durationSeconds = Number(values["duration-seconds"]);
const refreshSeconds = Number(values["refresh-seconds"]);
const activeWorkspaces = Number(
  values["active-workspaces"] ?? Math.max(1, Math.floor(workspaces / 2)),
);
const providers = Number(values.providers);
const discoveryModels = Number(values["discovery-models"]);
const teamShaped = durationSeconds > 0 || providers > 1;
const providerIds = Array.from({ length: providers }, (_, index) =>
  index === 0 ? "fixture-provider" : `fixture-provider-${index}`,
);
assert(Number.isSafeInteger(rows) && rows > 0);
assert(Number.isSafeInteger(workspaces) && workspaces > 0);
assert(Number.isSafeInteger(taskRounds) && taskRounds > 0);
assert(Number.isSafeInteger(idleSeconds) && idleSeconds >= 0, "--idle-seconds must be nonnegative");
assert(Number.isSafeInteger(durationSeconds) && durationSeconds >= 0);
assert(Number.isSafeInteger(refreshSeconds) && refreshSeconds > 0);
assert(
  Number.isSafeInteger(activeWorkspaces) && activeWorkspaces > 0 && activeWorkspaces <= workspaces,
);
assert(Number.isSafeInteger(providers) && providers > 0);
assert(Number.isSafeInteger(discoveryModels) && discoveryModels > 0);
assert(
  !durationSeconds || !values["measure-tasks"],
  "Timed refreshes and --measure-tasks are separate modes",
);
assert(providers === 1 || values["runtime-plugin"], "Multiple providers require --runtime-plugin");
const output = path.join(root, "workers");
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, "home"),
  OPENCLAW_HOME: path.join(root, "home"),
  OPENCLAW_STATE_DIR: path.join(root, "state"),
  OPENCLAW_CONFIG_PATH: path.join(root, "config.json"),
  CODEX_HOME: path.join(root, "codex"),
  TMPDIR: path.join(root, "tmp"),
  OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
};
for (const dir of [output, env.HOME, env.OPENCLAW_STATE_DIR, env.CODEX_HOME, env.TMPDIR]) {
  fs.mkdirSync(dir, { recursive: true });
}
Object.assign(process.env, env, { OPENCLAW_BENCH_RETAINED_WORKER_DIR: output });
if (idleSeconds > 0 || values["sample-allocation"]) {
  process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION = "1";
}
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
} else {
  delete process.env.OPENCLAW_BENCH_BASELINE_DIR;
}
// Install the same observer and optional source substitution before either owner imports.
if (values["built-worker"]) {
  assert(!values["owner-dir"], "--built-worker requires a complete build, not a source overlay");
  const workerEntry = path.resolve(
    values["built-worker"],
    "dist/agents/prepared-model-catalog.worker.js",
  );
  const NativeWorker = workerThreads.Worker;
  workerThreads.Worker = class extends NativeWorker {
    constructor(
      filename: ConstructorParameters<typeof NativeWorker>[0],
      options: ConstructorParameters<typeof NativeWorker>[1] = {},
    ) {
      const catalog = String(filename).endsWith("/prepared-model-catalog.worker.ts");
      super(
        catalog ? workerEntry : filename,
        catalog
          ? {
              ...options,
              execArgv: [
                "--import",
                new URL("./team-shape-stress-loader.mjs", import.meta.url).href,
                "--import",
                new URL("./worker-retained-heap-preload.ts", import.meta.url).href,
              ],
            }
          : options,
      );
    }
  };
  syncBuiltinESMExports();
}
await import("./worker-retained-heap-preload.js");
const workerMetrics =
  idleSeconds > 0 || durationSeconds > 0
    ? await import("../../src/infra/worker-cpu.js")
    : undefined;
workerMetrics?.setTrackedWorkerGcObserver(() => {});
const { CatalogWorkerTaskPool } =
  await import("../../src/agents/prepared-model-catalog-worker.pool.js");
const { loadPluginMetadataSnapshot } =
  await import("../../src/plugins/plugin-metadata-snapshot.js");
const { createPreparedModelCatalogWorkerInput } =
  await import("../../src/agents/prepared-model-catalog-worker.js");
const { AuthStorage } = await import("../../src/agents/sessions/auth-storage.js");
const { captureClawInstallSchemaVersionFacts } =
  await import("../../src/claws/provenance-runtime-read.js");
const { prepareSharedAuthStoreOwnership } =
  await import("../../src/agents/auth-profiles/path-resolve.js");
await prepareSharedAuthStoreOwnership(env);
const startupCatalog = durationSeconds > 0 ? createRemoteCatalog(0) : undefined;
if (startupCatalog) {
  const { captureRemoteModelCatalogStartupSnapshot, publishRemoteModelCatalogSnapshot } =
    await import("../../src/model-catalog/remote-overlay.js");
  assert(
    publishRemoteModelCatalogSnapshot(startupCatalog, null),
    "Synthetic startup catalog already published",
  );
  const inherited = captureRemoteModelCatalogStartupSnapshot();
  assert.equal(inherited?.sourceUrl, startupCatalog.sourceUrl);
  assert.equal(inherited?.revision, startupCatalog.revision);
}
const pluginDir = path.join(root, "plugin");
if (values["runtime-plugin"]) {
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "catalog-retention-fixture",
      providers: providerIds,
      modelCatalog: {
        discovery: Object.fromEntries(providerIds.map((provider) => [provider, "runtime"])),
        runtimeAugment: true,
      },
      configSchema: {
        type: "object",
        properties: { workspace: { type: "string" } },
        additionalProperties: false,
      },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `${teamShaped ? 'const { getCachedLiveCatalogValue } = require("openclaw/plugin-sdk/provider-catalog-shared");' : ""}
module.exports = { id: "catalog-retention-fixture", register(api) {
    for (const provider of ${JSON.stringify(providerIds)}) {
      api.registerProvider({ id: provider, label: "Synthetic catalog", auth: [],
        catalog: { async run(ctx) {
          const load = async () => ({ provider: {
              api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
              models: Array.from({ length: ${discoveryModels} }, (_, index) => ({
                id: "generated-" + index, name: "Generated " + index,
                contextWindow: 128000, maxTokens: 8192,
              })),
          } });
          ${
            teamShaped
              ? `const credential = ctx.resolveProviderAuth(provider).discoveryApiKey;
          if (credential !== "synthetic-" + api.pluginConfig.workspace + "-" + provider) {
            throw new Error("Synthetic provider/account credential was not resolved");
          }
          return getCachedLiveCatalogValue({
            keyParts: ["retention-fixture", provider, api.pluginConfig.workspace, credential], load,
          });`
              : "return load();"
          }
        } },
      });
    }
  } };`,
  );
}
const config = {
  plugins: values["runtime-plugin"]
    ? {
        load: { paths: [path.join(pluginDir, "index.cjs")] },
        allow: ["catalog-retention-fixture"],
      }
    : { enabled: false },
  models: {
    mode: values["runtime-plugin"] ? ("merge" as const) : ("replace" as const),
    providers: {
      "fixture-provider": {
        baseUrl: "https://fixture.invalid/v1",
        api: "openai-completions" as const,
        models: [
          {
            id: "fixture-model",
            name: "Fixture model",
            reasoning: false,
            input: ["text" as const],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 8192,
            maxTokens: 1024,
          },
        ],
      },
    },
  },
};
fs.writeFileSync(env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
const inputs = Array.from({ length: workspaces }, (_, index) => {
  const agentId = `synthetic-${index}`;
  const agentDir = path.join(env.OPENCLAW_STATE_DIR, "agents", agentId, "agent");
  const workspaceDir = path.join(root, `workspace-${index}`);
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const workspaceConfig =
    values["runtime-plugin"] && teamShaped
      ? {
          ...config,
          plugins: {
            ...config.plugins,
            entries: {
              "catalog-retention-fixture": { enabled: true, config: { workspace: agentId } },
            },
          },
        }
      : config;
  const credentials = Object.fromEntries(
    providerIds.map((provider) => [
      provider,
      {
        type: "api_key" as const,
        key: teamShaped ? `synthetic-${agentId}-${provider}` : "synthetic-not-real",
      },
    ]),
  );
  const input = { agentId, agentDir, workspaceDir, config: workspaceConfig, env };
  return createPreparedModelCatalogWorkerInput({
    agentFacts: {
      input,
      env,
      authStore: {
        version: 1,
        profiles: Object.fromEntries(
          providerIds.map((provider) => [
            provider,
            {
              ...credentials[provider]!,
              provider,
            },
          ]),
        ),
      },
      credentials,
      providerIds,
      configuredModelRefs: [],
      configuredRuntimeModels: [],
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
      templateAuthStorage: AuthStorage.inMemory({}),
    },
    pluginMetadataSnapshot: loadPluginMetadataSnapshot({
      config: workspaceConfig,
      env,
      workspaceDir,
    }),
  });
});
const pool = new CatalogWorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>(
  env,
  () => {},
);
let commands = 0;
const requests: Array<{
  revision: number;
  workspace: number;
  elapsedMs: number;
  entries: number;
  hash: string;
}> = [];
async function sample(
  name: string,
  operation: "collect" | "snapshot" | "start" | "stop" = "collect",
) {
  const ready = fs
    .readdirSync(output)
    .find(
      (file) =>
        file.endsWith(".ready.json") &&
        /^prepared-model-catalog\.worker\.[jt]s$/.test(
          JSON.parse(fs.readFileSync(path.join(output, file), "utf8")).script,
        ),
    );
  assert(ready, "Missing catalog-worker instrumentation after completed task");
  const identity = JSON.parse(fs.readFileSync(path.join(output, ready), "utf8"));
  const reply = identity.commandPath.replace(".command.json", `.${name}.json`);
  fs.writeFileSync(identity.commandPath + ".tmp", JSON.stringify({ id: name, operation }));
  fs.renameSync(identity.commandPath + ".tmp", identity.commandPath);
  const deadline = Date.now() + 120_000;
  while (!fs.existsSync(reply)) {
    assert(Date.now() < deadline, "Worker heap collection timed out");
    await delay(100);
  }
  const result = JSON.parse(fs.readFileSync(reply, "utf8"));
  assert(result.ok, JSON.stringify(result));
  console.log(
    JSON.stringify({ phase: name, commands, workspaces, rows, hostLoad: os.loadavg(), ...result }),
  );
}
function createRemoteCatalog(revision: number) {
  return {
    sourceUrl: "https://catalog.invalid/catalog.json",
    revision: `synthetic-revision-${revision}`,
    generatedAt: revision,
    providers: {
      "fixture-remote": {
        api: "openai-completions" as const,
        baseUrl: "https://remote.invalid/v1",
        models: Array.from({ length: rows }, (_, index) => ({
          id: `fixture-remote-${revision}-${index}`,
          name: `Synthetic model ${revision} ${index}`,
          contextWindow: 128000,
          maxTokens: 8192,
          input: ["text" as const],
          cost: { input: 1, output: 2 },
        })),
      },
    },
    recommendations: {},
    pricing: {},
    upstreamPricing: {},
  };
}
async function runRevision(revision: number, count = workspaces, timed = false) {
  const remoteCatalog =
    revision === 0 && startupCatalog ? startupCatalog : createRemoteCatalog(revision);
  if (startupCatalog) {
    assert.equal(remoteCatalog.sourceUrl, startupCatalog.sourceUrl);
    assert.equal(remoteCatalog.revision, `synthetic-revision-${revision}`);
  }
  for (const [index, input] of inputs.slice(0, count).entries()) {
    const started = performance.now();
    const value = { ...input, remoteCatalog };
    const result = await pool.run(
      {
        context: prepareModelCatalogWorkerContext(value),
        value,
        request: {
          kind: "catalog",
          ...(timed ? { refresh: true } : {}),
          syntheticAuth: [],
          clawInstallSchemaVersions: captureClawInstallSchemaVersionFacts({ env }),
        },
      },
      { timeoutMs: 120_000 },
    );
    const elapsedMs = performance.now() - started;
    assert(result.status === "ok" && result.kind === "catalog", JSON.stringify(result));
    assert(result.snapshot.entries.some((entry) => entry.id === "fixture-model"));
    if (values["runtime-plugin"]) {
      for (const provider of providerIds) {
        assert(
          result.snapshot.entries.some(
            (entry) =>
              entry.provider === provider && entry.id === `generated-${discoveryModels - 1}`,
          ),
        );
      }
    }
    requests.push({
      revision,
      workspace: index,
      elapsedMs,
      entries: result.snapshot.entries.length,
      hash: createHash("sha256").update(JSON.stringify(result.snapshot)).digest("hex"),
    });
    commands++;
    if (index === 0 && revision === 0) {
      await sample("one");
      if (values["measure-tasks"]) {
        await sample("tasks-start", "start");
      }
    }
  }
  if (!values["measure-tasks"] && !timed) {
    await sample(
      `revision-${revision}`,
      values.snapshot && durationSeconds === 0 && revision === taskRounds - 1
        ? "snapshot"
        : "collect",
    );
  }
}
try {
  for (let revision = 0; revision < taskRounds; revision++) {
    await runRevision(revision);
  }
  if (values["measure-tasks"]) {
    await sample("tasks-stop", "stop");
  }
  if (durationSeconds > 0) {
    await sample("refresh-start", "start");
    const started = performance.now();
    const sampleMemory = () =>
      console.log(
        JSON.stringify({
          phase: "refresh-memory",
          elapsedMs: performance.now() - started,
          commands,
          hostLoad: os.loadavg(),
          metrics: workerMetrics!.sampleTrackedWorkerMemory(),
        }),
      );
    sampleMemory();
    const timer = setInterval(sampleMemory, 30_000);
    let revision = taskRounds;
    try {
      while (performance.now() - started < durationSeconds * 1000) {
        const roundStarted = performance.now();
        await runRevision(revision++, activeWorkspaces, true);
        await delay(
          Math.max(
            0,
            Math.min(
              refreshSeconds * 1000 - (performance.now() - roundStarted),
              durationSeconds * 1000 - (performance.now() - started),
            ),
          ),
        );
      }
    } finally {
      clearInterval(timer);
      await sample("refresh-stop", "stop");
    }
    await sample("refresh-retained", values.snapshot ? "snapshot" : "collect");
    sampleMemory();
  }
  console.log(JSON.stringify({ phase: "requests", requests }));
  if (workerMetrics && idleSeconds > 0) {
    // Let the task owner's delayed idle collection finish before the measured window.
    await delay(1_100);
    await sample("idle-start", "start");
    let memoryRequests = 0;
    const sampleMemory = () => {
      memoryRequests++;
      return workerMetrics.sampleTrackedWorkerMemory();
    };
    const initialMetrics = sampleMemory();
    const timer = setInterval(sampleMemory, 30_000);
    try {
      await delay(idleSeconds * 1_000);
    } finally {
      clearInterval(timer);
      await sample("idle-stop", "stop");
    }
    console.log(
      JSON.stringify({
        phase: "idle",
        idleSeconds,
        memoryRequests,
        memorySampleIntervalMs: 30_000,
        catalogDigest: createHash("sha256")
          .update(JSON.stringify(requests.map(({ entries, hash }) => ({ entries, hash }))))
          .digest("hex"),
        initialMetrics,
        finalMetrics: workerMetrics.sampleTrackedWorkerMemory(),
      }),
    );
  }
} finally {
  await pool.close();
  workerMetrics?.setTrackedWorkerGcObserver(undefined);
}
