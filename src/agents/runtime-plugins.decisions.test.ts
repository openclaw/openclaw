import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import { captureRuntimeConfig } from "../config/runtime-source-projection.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { inspectDecisionProviders } from "../decisions/runtime.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { loadPluginManifestRegistryCore } from "../plugins/manifest-registry.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { loadAgentRuntimePluginRegistryHandle } from "./runtime-plugins.js";

afterEach(() => {
  resetPluginLoaderTestStateForTest();
  clearRuntimeConfigSnapshot();
});

it.each([undefined, "consumer/check"])("prepared provider for task %s", async (taskId) => {
  const state = await createOpenClawTestState({
    prefix: "decisions-prepared-registry-",
    env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
  });
  const pluginDir = state.statePath("fixture");
  await state.writeText(
    "fixture/index.cjs",
    `module.exports = {
    id: "fixture",
    register(api) {
      api.registerDecisionProvider({
        id: "fixture", contractVersion: 1,
        isReady: () => typeof api.pluginConfig.apiKey === "string",
        async evaluate() { return { status: "ok", result: { model: "synthetic", answers: { check: { type: "boolean", probabilityTrue: 1 } } } }; }
      });
    }
  };`,
  );
  await state.writeJson("fixture/openclaw.plugin.json", {
    id: "fixture",
    contracts: { decisionProviders: ["fixture"] },
    configContracts: {
      secretInputs: { paths: [{ path: "apiKey", expected: "string", ownerKind: "capability" }] },
    },
    configSchema: {
      type: "object",
      required: ["apiKey"],
      properties: { apiKey: { type: "object", required: ["source", "provider", "id"] } },
    },
  });
  await state.writeText(
    "consumer/index.cjs",
    `module.exports = {
    id: "consumer",
    register(api) {
      if (Object.keys(api.pluginConfig ?? {}).length) throw new Error("Consumer must not require credentials");
      api.registerTool({
        name: "fixture_decision", label: "Fixture", description: "Fixture", parameters: { type: "object" },
        async execute() {
          const details = await api.runtime.decisions.evaluate(
            { state: "synthetic", questions: { check: { type: "boolean" } } },
            { taskId: ${JSON.stringify(taskId) ?? "undefined"}, purpose: "test", rubricVersion: "1", timeoutMs: 1000, signal: new AbortController().signal }
          );
          return { content: [], details };
        }
      });
    }
  };`,
  );
  await state.writeJson("consumer/openclaw.plugin.json", {
    id: "consumer",
    contracts: { tools: ["fixture_decision"] },
    configSchema: { type: "object", additionalProperties: false },
  });
  const source: OpenClawConfig = {
    agents: {
      defaults: taskId
        ? { decisionModelsByTask: { [taskId]: "fixture/synthetic" } }
        : { decisionModel: "fixture/synthetic" },
    },
    plugins: {
      allow: ["fixture", "consumer"],
      slots: { memory: "none" },
      load: { paths: [path.join(pluginDir, "index.cjs"), state.statePath("consumer/index.cjs")] },
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
      workspaceDir: state.workspaceDir,
    }),
  });
  expect(activated.autoEnabledReasons.fixture).toEqual(["fixture decision provider selected"]);
  const runtime: OpenClawConfig = structuredClone(activated.config);
  runtime.plugins!.entries!.fixture!.config!.apiKey = "synthetic-prepared";
  setRuntimeConfigSnapshot(runtime, source);
  const root = loadAndActivateRootPluginRegistry({
    config: runtime,
    activationSourceConfig: source,
    autoEnabledReasons: activated.autoEnabledReasons,
    workspaceDir: state.workspaceDir,
    cache: false,
  });
  let scoped: ReturnType<typeof loadAgentRuntimePluginRegistryHandle> | undefined;
  try {
    expect(root.plugins.find((plugin) => plugin.id === "fixture")?.status).toBe("loaded");
    scoped = loadAgentRuntimePluginRegistryHandle({
      config: captureRuntimeConfig(runtime),
      workspaceDir: state.workspaceDir,
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
    expect(inspectDecisionProviders(runtime, root)[0]).toMatchObject({
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
