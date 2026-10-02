import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import { materializePreparedRuntimeModel } from "../runtime-plan/materialize-model.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { createEmptyAgentDiscoveryStores, resolveModelAsync } from "./model.js";

const provider = "selected-model-test";
const metadataSnapshot = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: provider,
      providers: [provider],
      modelIdNormalization: {
        providers: { [provider]: { aliases: { entry: "middle", middle: "final" } } },
      },
    },
  ],
});

function createResolutionOptions() {
  const stores = createEmptyAgentDiscoveryStores();
  stores.modelRegistry.registerProvider(provider, {
    api: "openai-completions",
    baseUrl: "https://selected-model.example/v1",
    models: ["middle", "final"].map((id) =>
      Object.assign(
        makeProviderModelFixture({
          provider,
          id,
          api: "openai-completions",
          baseUrl: "https://selected-model.example/v1",
        }),
        { contextWindow: 16_000, maxTokens: 4_096 },
      ),
    ),
  });
  return { ...stores, skipAgentDiscovery: true, skipProviderRuntimeHooks: true };
}

describe("selected model materialization", () => {
  it.each(["credential", "route"] as const)(
    "preserves the selected executable ID during %s materialization",
    async (mode) => {
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const options = createResolutionOptions();
        const selected = await resolveModelAsync(provider, "entry", undefined, {}, options);
        expect(selected.model?.id).toBe("middle");
        const model = await materializePreparedRuntimeModel({
          plan: {
            providerForAuth: provider,
            authProfileProviderForAuth: provider,
            selectedAuthMode: "api-key",
            ...(mode === "route"
              ? {
                  modelRoute: {
                    provider,
                    modelId: "middle",
                    api: "openai-completions" as const,
                    baseUrl: "https://selected-model.example/v1",
                    authRequirement: "api-key" as const,
                    requestTransportOverrides: "none" as const,
                  },
                }
              : {}),
          },
          provider,
          modelId: "middle",
          model: selected.model,
          metadataSnapshot,
          forceResolve: true,
          resolveModel: () =>
            resolveModelAsync(
              provider,
              "middle",
              undefined,
              {},
              {
                ...options,
                modelIdSource: "selected",
              },
            ),
        });
        expect(model?.id).toBe("middle");
      });
    },
  );
});
