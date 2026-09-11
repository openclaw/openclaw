import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../../config/runtime-snapshot.js";
import { withPluginMetadataSnapshotScope } from "../../plugins/current-plugin-metadata-snapshot.js";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { buildConfiguredFallbackModel } from "./model.configured-fallback.js";
import { applyConfiguredProviderOverrides } from "./model.configured-overrides.js";
import {
  catalogCost,
  flatCatalogCost,
  sourceRow,
  staleCost,
} from "./model.configured-pricing.test-support.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";

afterEach(clearRuntimeConfigSnapshot);
function createRuntimeHooks() {
  return createProviderRuntimeTestMock({
    handledDynamicProviders: ["google-antigravity", "zai", "openai"],
  });
}

describe("captured configured pricing policies", () => {
  it.each([false, true])(
    "uses captured pricing aliases once with a cloned config: %s",
    (cloneRuntime) => {
      const provider = "pricing-fixture";
      const model = {
        ...makeModel("middle"),
        api: "openai-completions" as const,
        input: ["text" as const],
        contextWindow: 1,
        cost: staleCost,
      };
      const providerConfig = { baseUrl: "https://models.example/v1", models: [model] };
      const runtime: OpenClawConfig = { models: { providers: { [provider]: providerConfig } } };
      const source = {
        models: {
          providers: {
            [provider]: { ...providerConfig, models: [sourceRow("latest", { input: 7 })] },
          },
        },
      } as unknown as OpenClawConfig;
      setRuntimeConfigSnapshot(runtime, source);
      const cfg = cloneRuntime ? structuredClone(runtime) : runtime;
      const captured = createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: provider,
            providers: [provider],
            modelIdNormalization: {
              providers: { [provider]: { aliases: { latest: "middle", middle: "final" } } },
            },
          },
        ],
      });
      const discoveredModel = {
        ...model,
        provider,
        baseUrl: providerConfig.baseUrl,
        cost: catalogCost,
      };
      withPluginMetadataSnapshotScope(createPluginMetadataSnapshotFixture(), () => {
        const result = applyConfiguredProviderOverrides({
          provider,
          discoveredModel,
          providerConfig,
          modelId: "middle",
          cfg,
          manifestAlias: { provider },
          providerMetadataOwners: captured.owners,
          runtimeHooks: createRuntimeHooks(),
        });
        const fallback = buildConfiguredFallbackModel({
          provider,
          modelId: "middle",
          cfg,
          manifestAlias: { provider },
          providerMetadataOwners: captured.owners,
          getStaticCatalogModel: () => discoveredModel,
          runtimeHooks: createRuntimeHooks(),
        });
        expect(result.id).toBe("middle");
        expect(fallback?.id).toBe("middle");
        expect(result.cost).toEqual({ ...flatCatalogCost, input: 7 });
        expect(fallback?.cost).toEqual({ ...flatCatalogCost, input: 7 });
      });
    },
  );
});
