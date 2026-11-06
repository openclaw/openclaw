// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayReloadPlan } from "../gateway/config-reload-plan.js";
import {
  createGatewayModelRuntimeReload,
  refreshModelRuntimeAfterHotReload,
} from "../gateway/server-reload-model-runtime-scope.js";
import * as modelCatalog from "../model-catalog/index.js";
import { buildCatalogModel } from "../plugin-sdk/provider-catalog.test-support.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { getPluginRuntimeLoadContextState } from "../plugins/runtime/load-context-state.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { withPreparedModelRuntimePluginGenerationScope as withGeneration } from "./prepared-model-runtime-generation-scope.js";
import {
  loadPublishedGatewayReplyDispatchRuntime as loadDispatch,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness(
  { label: "descriptor-auth-reload" },
  clearRuntimeConfigSnapshot,
);

it("rejects descriptors captured before auth reload rebinds the retained plugin generation", async () => {
  const { prepareImplicitProviderStaticCatalog, resolveImplicitProviders } = await vi.importActual<
    typeof import("./models-config.providers.implicit.js")
  >("./models-config.providers.implicit.js");
  const id = "descriptor-reload";
  const providerConfig = {
    api: "openai-completions" as const,
    baseUrl: "https://catalog.example.invalid/v1",
    models: [buildCatalogModel("configured")],
  };
  const metadata = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id,
        providers: [id],
        modelCatalog: { discovery: { [id]: "static" }, providers: { [id]: providerConfig } },
      },
    ],
  });
  const registry = createEmptyPluginRegistry();
  registry.plugins.push(createPluginRecord({ id }));
  const before: OpenClawConfig = {
    agents: { defaults: { model: `${id}/configured` } },
    plugins: { allow: [id] },
  };
  const after: OpenClawConfig = {
    ...before,
    auth: { profiles: { [`${id}:manual`]: { provider: id, mode: "api_key" } } },
  };
  fixture.mocks.configuredAgentIds = ["default"];
  fixture.mocks.loadAgentRuntimePluginRegistryHandle.mockReturnValue(registry);
  fixture.mocks.prepareStaticCatalog.mockImplementation(prepareImplicitProviderStaticCatalog);
  setRuntimeConfigSnapshot(before, before);
  await refreshPreparedModelRuntimeSnapshots(before, {
    gatewayLifecycle: true,
    catalogMode: "static",
    allowGatewaySubagentBinding: true,
    pluginMetadataSnapshot: metadata,
  });
  const previous = await loadDispatch({ agentId: "default" });
  const generation = previous!.pluginGeneration!;
  const prepared = generation.preparedStaticProviderCatalog!;
  const binding = getPluginRuntimeLoadContextState(registry);
  expect(generation.pluginRegistry).toBe(registry);
  expect(prepared.providers).toHaveLength(1);
  const read = (config: OpenClawConfig) =>
    withGeneration(generation, () =>
      resolveImplicitProviders({
        config,
        env: process.env,
        agentDir: fixture.state.agentDir("default"),
        authStore: { version: 1, profiles: {} },
        pluginMetadataSnapshot: metadata,
        providerDiscoveryProviderIds: [id],
        preparedStaticProviderCatalog: prepared,
      }),
    );
  using plans = vi.spyOn(modelCatalog, "planEffectiveModelCatalogRows");
  await read(before);
  expect(plans).not.toHaveBeenCalled();
  const reload = createGatewayModelRuntimeReload().prepare(
    buildGatewayReloadPlan([`auth.profiles.${id}:manual`]),
    before,
    after,
  );
  expect(reload.scope.preservePluginGenerations).toBe(true);
  setRuntimeConfigSnapshot(after, after);
  await refreshModelRuntimeAfterHotReload({
    config: after,
    agentIds: reload.agentIds,
    ...reload.scope,
    pluginMetadataSnapshot: metadata,
  });
  const current = await loadDispatch({ agentId: "default" });
  expect(current?.config).toBe(after);
  expect(current?.pluginGeneration).toBe(generation);
  expect(current?.pluginGeneration?.preparedStaticProviderCatalog).toBe(prepared);
  expect(getPluginRuntimeLoadContextState(registry)).not.toBe(binding);
  expect(getPluginRuntimeLoadContextState(registry)?.rawConfig).toBe(after);
  plans.mockClear();
  expect((await read(after))?.[id]?.models[0]?.id).toBe("configured");
  expect(plans).toHaveBeenCalledOnce();
});
