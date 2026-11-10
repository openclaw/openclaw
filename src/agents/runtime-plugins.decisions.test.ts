import { afterEach, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { writeFixtureJson } from "../plugins/loader-fixture-builders.test-support.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest, writePlugin } from "../plugins/loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});

it("lets a separate credential-free plugin invoke the prepared Gateway decision provider", async () => {
  const state = await createOpenClawTestState({
    prefix: "decisions-prepared-registry-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const { workspaceDir } = state;
  function createPlugin(id: string, registration: string, manifest: Record<string, unknown>) {
    const entry = writePlugin({ id, dir: state.statePath(id), registration });
    writeFixtureJson(entry.dir, "openclaw.plugin.json", { id, ...manifest });
    return entry.file;
  }
  const provider = createPlugin(
    "fixture",
    `
      api.registerDecisionProvider({
        id: "fixture", contractVersion: 1,
        isReady: () => typeof api.pluginConfig.apiKey === "string",
        async evaluate() { return { status: "ok", result: { model: "synthetic", answers: { check: { type: "boolean", probabilityTrue: 1 } } } }; }
      });
`,
    {
      contracts: { decisionProviders: ["fixture"] },
      configContracts: {
        secretInputs: { paths: [{ path: "apiKey", expected: "string", ownerKind: "capability" }] },
      },
      configSchema: {
        type: "object",
        required: ["apiKey"],
        properties: { apiKey: { type: "object", required: ["source", "provider", "id"] } },
      },
    },
  );
  const consumer = createPlugin(
    "consumer",
    `
      if (Object.keys(api.pluginConfig ?? {}).length) throw new Error("Consumer must not require credentials");
      api.registerTool({
        name: "fixture_decision", label: "Fixture", description: "Fixture", parameters: { type: "object" },
        async execute() {
          const details = await api.runtime.decisions.evaluate(
            { state: "synthetic", questions: { check: { type: "boolean" } } },
            { purpose: "test", rubricVersion: "1", timeoutMs: 1000, signal: new AbortController().signal }
          );
          return { content: [], details };
        }
      });
`,
    {
      contracts: { tools: ["fixture_decision"] },
      configSchema: { type: "object", additionalProperties: false },
    },
  );
  const source: OpenClawConfig = {
    agents: { defaults: { decisionModel: "fixture/synthetic" } },
    plugins: {
      allow: ["fixture", "consumer"],
      slots: { memory: "none" },
      load: { paths: [provider, consumer] },
      entries: {
        consumer: { enabled: true },
        fixture: {
          config: { apiKey: { source: "store", provider: "default", id: "SYNTHETIC_KEY" } },
        },
      },
    },
  };
  const activated = applyPluginAutoEnable({
    config: source,
    manifestRegistry: loadPluginManifestRegistryCore({
      config: source,
      workspaceDir,
    }),
  });
  expect(activated.autoEnabledReasons.fixture).toEqual(["fixture decision provider selected"]);
  const runtime: OpenClawConfig = structuredClone(activated.config);
  runtime.plugins!.entries!.fixture!.config!.apiKey = "synthetic-prepared";
  setRuntimeConfigSnapshot(runtime, source);
  const root = await loadAndActivateRootPluginRegistry({
    config: runtime,
    activationSourceConfig: source,
    autoEnabledReasons: activated.autoEnabledReasons,
    workspaceDir,
    cache: false,
  });
  let scoped: ReturnType<typeof loadAgentRuntimePluginRegistryHandle> | undefined;
  try {
    expect(root.plugins.find((plugin) => plugin.id === "fixture")?.status).toBe("loaded");
    scoped = loadAgentRuntimePluginRegistryHandle({
      config: captureRuntimeConfig(runtime),
      workspaceDir,
      allowGatewaySubagentBinding: true,
      basePluginIds: ["fixture", "consumer"],
    });
    expect(scoped.plugins.find((plugin) => plugin.id === "fixture")?.status).toBe("loaded");
    expect(scoped.decisionProviders[0]?.host).toBe(root.decisionProviders[0]?.host);
    const record = scoped.plugins.find((plugin) => plugin.id === "consumer")!;
    expect(record.status).toBe("loaded");
    const tool = scoped.tools[0]!.factory({});
    if (!tool || Array.isArray(tool)) {
      throw new Error("Expected one fixture tool");
    }
    expect(
      await getPluginInstance(record)!.runInRegistry(scoped, () => tool.execute("probe", {})),
    ).toMatchObject({ details: { status: "ok" } });
    expect(root.decisionProviders[0]!.host.inspect(runtime)).toMatchObject({
      successCount: 1,
      activeRequests: 0,
    });
  } finally {
    for (const registry of new Set([root, scoped])) {
      for (const record of registry?.plugins ?? []) {
        await getPluginInstance(record)?.dispose();
      }
    }
    await state.cleanup();
  }
});
