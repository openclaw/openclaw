// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { usePreparedModelRuntimeHarness } from "./prepared-model-runtime.test-harness.js";
import { expect, it, vi } from "vitest";
import * as providerPolicy from "../plugins/provider-policy-surface.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import {
  getPluginRuntimeGenerationRegistry,
  withPluginRuntimeGenerationScope,
} from "../plugins/runtime/generation-scope.js";
import {
  prepareModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const fixture = usePreparedModelRuntimeHarness({ label: "catalog-projection-generation" });
const { mocks } = fixture;

it("retains the prepared plugin generation during deferred catalog normalization", async () => {
  const config = {};
  mocks.configuredAgentIds = ["default"];
  await refreshPreparedModelRuntimeSnapshots(config, {
    gatewayLifecycle: true,
    catalogMode: "static",
  });
  const owner = await prepareModelRuntimeSnapshot(fixture.agentInput("default", config));
  await owner.loadFullModelCatalog!({ refresh: true, wait: true });
  expect(owner.pluginRegistry).toBeDefined();
  const registries: unknown[] = [];
  mocks.modelRegistry.getAll.mockImplementation(() => {
    registries.push(getPluginRuntimeGenerationRegistry());
    return [];
  });
  const ambientRegistry = createEmptyPluginRegistry();
  const policy = vi
    .spyOn(providerPolicy, "resolveDirectBundledProviderPolicySurface")
    .mockImplementation((provider) =>
      provider === "fixture"
        ? {
            normalizeModelCatalogId:
              getPluginRuntimeGenerationRegistry() === owner.pluginRegistry
                ? ({ modelId }) => (modelId === "legacy" ? "canonical" : modelId)
                : ({ modelId }) => modelId,
          }
        : null,
    );
  const entries = ["legacy", "canonical"].map((id) => ({
    id,
    name: id,
    provider: "fixture",
  }));
  mocks.runPreparedModelCatalogWorker.mockResolvedValue({ entries, routeVariants: entries });
  try {
    const catalog = await withPluginRuntimeGenerationScope(
      { metadataSnapshot: owner.metadataSnapshot, pluginRegistry: ambientRegistry },
      async () => {
        const result = await owner.loadFullModelCatalog!({ refresh: true, wait: true });
        expect(getPluginRuntimeGenerationRegistry()).toBe(ambientRegistry);
        return result;
      },
    );
    expect(
      catalog.entries.filter(({ provider }) => provider === "fixture").map(({ id }) => id),
    ).toEqual(["legacy"]);
    expect(
      catalog.routeVariants.filter(({ provider }) => provider === "fixture").map(({ id }) => id),
    ).toEqual(["legacy"]);
  } finally {
    policy.mockRestore();
  }
  expect(registries.length).toBeGreaterThan(0);
  expect(registries.every((registry) => registry === owner.pluginRegistry)).toBe(true);
  expect(getPluginRuntimeGenerationRegistry()).toBeUndefined();
});
