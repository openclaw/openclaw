/**
 * Synthetic catalog-worker retention, with forced GC outside request timing windows.
 * Run: node --import ./scripts/tsx.mjs scripts/perf/catalog-worker-retention-measure.ts
 *   --output /absolute/new-fixture --workspaces 5 --models 5000 --runtime-plugin [--snapshot]
 * Alternate independent baseline/candidate launches; --owner-dir substitutes pinned source files.
 * Add --idle-seconds 600 for an allocation/GC profile after catalog tasks settle, with
 * production worker diagnostics enabled and memory requests every 30 seconds. No forced GC
 * occurs inside that window. The preload's sampling/polling overhead is present in both arms.
 * Source-mode heap includes the TypeScript loader; do not equate it with packaged Gateway RSS.
 * This exercises a real catalog worker, not a complete Gateway or its client workload.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
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
    "runtime-plugin": { type: "boolean", default: false },
    "idle-seconds": { type: "string", default: "0" },
  },
});
assert(values.output, "--output must name a new synthetic fixture directory");
const root = path.resolve(values.output);
assert(!fs.existsSync(root), "Refusing to reuse an existing fixture directory");
const rows = Number(values.models);
const workspaces = Number(values.workspaces);
const idleSeconds = Number(values["idle-seconds"]);
assert(Number.isSafeInteger(rows) && rows > 0);
assert(Number.isSafeInteger(workspaces) && workspaces > 0);
assert(Number.isSafeInteger(idleSeconds) && idleSeconds >= 0, "--idle-seconds must be nonnegative");
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
if (idleSeconds > 0) {
  process.env.OPENCLAW_BENCH_SAMPLE_ALLOCATION = "1";
}
if (values["owner-dir"]) {
  process.env.OPENCLAW_BENCH_BASELINE_DIR = path.resolve(values["owner-dir"]);
} else {
  delete process.env.OPENCLAW_BENCH_BASELINE_DIR;
}
// Install the same observer and optional source substitution before either owner imports.
await import("./worker-retained-heap-preload.js");
const workerMetrics = idleSeconds > 0 ? await import("../../src/infra/worker-cpu.js") : undefined;
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
const pluginDir = path.join(root, "plugin");
if (values["runtime-plugin"]) {
  fs.mkdirSync(pluginDir);
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: "catalog-retention-fixture",
      providers: ["fixture-provider"],
      modelCatalog: { discovery: { "fixture-provider": "runtime" }, runtimeAugment: true },
      configSchema: { type: "object", additionalProperties: false },
    }),
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = { id: "catalog-retention-fixture", register(api) {
      api.registerProvider({ id: "fixture-provider", label: "Synthetic catalog", auth: [],
        catalog: { run() { return { provider: {
          api: "openai-completions", baseUrl: "https://fixture.invalid/v1",
          models: Array.from({ length: 500 }, (_, index) => ({
            id: "generated-" + index, name: "Generated " + index,
            contextWindow: 128000, maxTokens: 8192,
          })),
        } }; } },
      });
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
  const input = { agentId, agentDir, workspaceDir, config, env };
  return createPreparedModelCatalogWorkerInput({
    agentFacts: {
      input,
      env,
      authStore: {
        version: 1,
        profiles: {
          fixture: { type: "api_key", provider: "fixture-provider", key: "synthetic-not-real" },
        },
      },
      credentials: { "fixture-provider": { type: "api_key", key: "synthetic-not-real" } },
      providerIds: ["fixture-provider"],
      configuredModelRefs: [],
      configuredRuntimeModels: [],
      runtimeCapabilityModels: [],
      configuredGeneratedCatalogPluginIds: [],
      templateAuthStorage: AuthStorage.inMemory({}),
    },
    pluginMetadataSnapshot: loadPluginMetadataSnapshot({ config, env, workspaceDir }),
  });
});
const pool = new CatalogWorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>(
  env,
  () => {},
);
let commands = 0;
const requests: Array<{ elapsedMs: number; entries: number; hash: string }> = [];
async function sample(
  name: string,
  operation: "collect" | "snapshot" | "start" | "stop" = "collect",
) {
  const ready = fs
    .readdirSync(output)
    .find(
      (file) =>
        file.endsWith(".ready.json") &&
        JSON.parse(fs.readFileSync(path.join(output, file), "utf8")).script ===
          "prepared-model-catalog.worker.ts",
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
  console.log(JSON.stringify({ phase: name, commands, workspaces, rows, ...result }));
}
try {
  for (let revision = 0; revision < 2; revision++) {
    const remoteCatalog = {
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
    for (const [index, input] of inputs.entries()) {
      const started = performance.now();
      const result = await pool.run(
        {
          value: { ...input, remoteCatalog },
          request: {
            kind: "catalog",
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
        assert(result.snapshot.entries.some((entry) => entry.id === "generated-499"));
      }
      requests.push({
        elapsedMs,
        entries: result.snapshot.entries.length,
        hash: createHash("sha256").update(JSON.stringify(result.snapshot)).digest("hex"),
      });
      commands++;
      if (index === 0 && revision === 0) {
        await sample("one");
      }
    }
    await sample(
      `revision-${revision}`,
      values.snapshot && revision === 1 ? "snapshot" : "collect",
    );
  }
  console.log(JSON.stringify({ phase: "requests", requests }));
  if (workerMetrics) {
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
