/**
 * 200 real isolated completions against a synthetic loopback SSE provider with 500 catalog rows.
 * node --expose-gc --import ./scripts/tsx.mjs scripts/perf/isolated-completion-registry-measure.ts
 *   [--owner /absolute/model-registry.core.ts] [--allocation] [--counts]
 * Run five serial A1/A2/B rounds; timing and GC-inclusive allocation are separate processes.
 * --owner selects the baseline registry implementation before importing the production flow.
 * Accept identical selections/replies, one copied row per completion, lower allocation/CPU;
 * report latency spread and cold preparation separately. No external provider or Team data.
 */
import assert from "node:assert/strict";
import { hash } from "node:crypto";
import { readFileSync } from "node:fs";
import { Session } from "node:inspector/promises";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { loadavg } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    owner: { type: "string" },
    allocation: { type: "boolean" },
    counts: { type: "boolean" },
    iterations: { type: "string", default: "200" },
  },
});
const iterations = Number(values.iterations);
assert(Number.isSafeInteger(iterations) && iterations > 0);
const ownerUrl = new URL("../../src/agents/sessions/model-registry.core.ts", import.meta.url);
const source = readFileSync(values.owner ?? fileURLToPath(ownerUrl), "utf8");
if (values.owner) {
  const baseline = stripTypeScriptTypes(source);
  registerHooks({
    load(url, context, nextLoad) {
      return url === ownerUrl.href
        ? { format: "module", source: baseline, shortCircuit: true }
        : nextLoad(url, context);
    },
  });
}
const { runIsolatedCompletion } = await import("../../src/agents/isolated-completion.js");
const { ModelRegistry } = await import("../../src/agents/sessions/model-registry.core.js");
const createRegistryAsync = ModelRegistry.createAsync;
const registryFromCapturedSources = ModelRegistry.fromCapturedSources;
const { refreshPreparedModelRuntimeSnapshots } =
  await import("../../src/agents/prepared-model-runtime.js");
const { withOpenClawTestState } = await import("../../src/test-utils/openclaw-test-state.js");
const { completionModelDefinition, startCompletionServer, completionChunk } =
  await import("../../src/agents/simple-completion.test-support.js");
const { closePreparedModelRuntimeSnapshots } =
  await import("../../src/agents/prepared-model-runtime.lifecycle.js");
const { clearActivePluginRegistry } = await import("../../src/plugins/runtime.js");
const provider = "synthetic-completion";
const models = Array.from({ length: 500 }, (_, i) =>
  completionModelDefinition({ id: `model-${i}` }),
);
const inspector = new Session();
inspector.connect();
try {
  await withOpenClawTestState(
    {
      label: "isolated-completion-registry",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost", "::1"].filter(Boolean).join(","),
      },
    },
    async (state) => {
      let requests = 0;
      let ownerWallMs = 0,
        ownerCpuUs = 0,
        ownerCalls = 0;
      const observeRegistry = (registry: ReturnType<typeof registryFromCapturedSources>) => {
        const fork = registry.fork.bind(registry);
        registry.fork = (...args) => {
          const start = performance.now(),
            cpu = process.threadCpuUsage();
          try {
            return fork(...args);
          } finally {
            const used = process.threadCpuUsage(cpu);
            ownerCpuUs += used.user + used.system;
            ownerWallMs += performance.now() - start;
            ownerCalls++;
          }
        };
        return registry;
      };
      if (!values.allocation && !values.counts) {
        ModelRegistry.createAsync = async (...args) =>
          observeRegistry(await createRegistryAsync(...args));
        ModelRegistry.fromCapturedSources = (...args) =>
          observeRegistry(registryFromCapturedSources(...args));
      }
      await using server = await startCompletionServer((request, response) => {
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk: string) => {
          body += chunk;
        });
        request.on("end", () => {
          const parsed: unknown = JSON.parse(body);
          assert(
            parsed && typeof parsed === "object" && "model" in parsed && parsed.model === "model-0",
          );
          requests++;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(completionChunk("synthetic reply", "model-0"));
        });
      });
      const runtimePath = await state.writeText(
        "provider/index.cjs",
        `module.exports = { id: "${provider}", register(api) { api.registerProvider({ id: "${provider}", label: "Synthetic", auth: [] }); } };`,
      );
      await state.writeJson("provider/openclaw.plugin.json", {
        id: provider,
        providers: [provider],
        configSchema: { type: "object", properties: {}, additionalProperties: false },
        modelCatalog: {
          discovery: { [provider]: "static" },
          providers: { [provider]: { api: "openai-completions", baseUrl: server.baseUrl, models } },
        },
      });
      const config = {
        agents: {
          defaults: { workspace: state.workspaceDir, model: { primary: `${provider}/model-0` } },
        },
        models: {
          providers: {
            [provider]: {
              api: "openai-completions" as const,
              baseUrl: server.baseUrl,
              apiKey: "synthetic-fixture-key",
              models,
            },
          },
        },
        plugins: {
          allow: [provider],
          entries: { [provider]: { enabled: true } },
          load: { paths: [runtimePath] },
          slots: { memory: "none" },
        },
      };
      await state.writeConfig(config);
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
      });
      const run = async (count: number) => {
        for (let i = 0; i < count; i++) {
          const result = await runIsolatedCompletion({
            config,
            agentId: "main",
            agentDir: state.agentDir(),
            workspaceDir: state.workspaceDir,
            provider,
            model: "model-0",
            agentHarnessRuntimeOverride: "openclaw",
            systemPrompt: "Return a short title.",
            prompt: "Synthetic fixture.",
            timeoutMs: 60000,
          });
          assert.equal(result.text, "synthetic reply");
        }
      };
      try {
        const cold = performance.now();
        await run(5);
        const coldAndWarmupMs = performance.now() - cold;
        await inspector.post("HeapProfiler.collectGarbage");
        const clone = globalThis.structuredClone;
        ownerWallMs = 0;
        ownerCpuUs = 0;
        ownerCalls = 0;
        let catalogClones = 0,
          copiedRows = 0;
        const fullCloneStacks = new Set<string>();
        if (values.counts) {
          globalThis.structuredClone = (value, options) => {
            if (Array.isArray(value) && value[0]?.provider === provider) {
              catalogClones++;
              copiedRows += value.length;
              if (value.length > 1) {
                fullCloneStacks.add(new Error("catalog clone").stack ?? "");
              }
            }
            return clone(value, options);
          };
        }
        if (values.allocation) {
          await inspector.post("HeapProfiler.startSampling", {
            samplingInterval: 4096,
            includeObjectsCollectedByMajorGC: true,
            includeObjectsCollectedByMinorGC: true,
          });
        }
        const cpu0 = process.cpuUsage(),
          start = performance.now(),
          hostLoad = loadavg();
        const requestStart = requests;
        try {
          await run(iterations);
        } finally {
          globalThis.structuredClone = clone;
        }
        const wallMs = performance.now() - start,
          cpu = process.cpuUsage(cpu0);
        const profile = values.allocation
          ? (await inspector.post("HeapProfiler.stopSampling")).profile
          : undefined;
        assert.equal(requests - requestStart, iterations);
        if (!values.allocation && !values.counts) {
          assert.equal(ownerCalls, iterations);
        }
        console.log(
          JSON.stringify({
            ownerSha256: hash("sha256", source),
            node: process.version,
            iterations,
            catalogRows: models.length,
            mode: values.counts ? "counts" : values.allocation ? "allocation" : "timing",
            coldAndWarmupMs,
            wallMs,
            processCpuMs: (cpu.user + cpu.system) / 1000,
            ownerWallMs: values.allocation || values.counts ? undefined : ownerWallMs,
            ownerCpuMs: values.allocation || values.counts ? undefined : ownerCpuUs / 1000,
            sampledBytes: profile?.samples.reduce((n, s) => n + s.size, 0),
            catalogClones: values.counts ? catalogClones : undefined,
            copiedRows: values.counts ? copiedRows : undefined,
            fullCloneStacks: values.counts ? [...fullCloneStacks] : undefined,
            hostLoad,
          }),
        );
      } finally {
        await closePreparedModelRuntimeSnapshots();
        await clearActivePluginRegistry();
      }
    },
  );
} finally {
  ModelRegistry.createAsync = createRegistryAsync;
  ModelRegistry.fromCapturedSources = registryFromCapturedSources;
  inspector.disconnect();
}
