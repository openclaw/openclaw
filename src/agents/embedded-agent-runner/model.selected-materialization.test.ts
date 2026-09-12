import { describe, expect, it } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../../plugins/plugin-metadata.test-support.js";
import { withPluginRuntimeGenerationScope } from "../../plugins/runtime/generation-scope.js";
import type { PreparedModelRuntimeSnapshot } from "../prepared-model-runtime.types.js";
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
  it("keeps raw input alias resolution", async () => {
    await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
      const options = createResolutionOptions();
      for (const [input, expected] of [
        ["entry", "middle"],
        ["middle", "final"],
      ] as const) {
        const result = await resolveModelAsync(provider, input, undefined, {}, options);
        expect(result.model?.id).toBe(expected);
      }
    });
  });

  it.each(["direct", "credential", "route"] as const)(
    "preserves the selected executable ID during %s materialization",
    async (mode) => {
      await withPluginRuntimeGenerationScope({ metadataSnapshot }, async () => {
        const options = createResolutionOptions();
        const selected = await resolveModelAsync(provider, "entry", undefined, {}, options);
        expect(selected.model?.id).toBe("middle");
        const resolveModel = () =>
          resolveModelAsync(
            provider,
            "middle",
            undefined,
            {},
            {
              ...options,
              modelIdSource: "selected",
            },
          );
        const model =
          mode === "direct"
            ? (await resolveModel()).model
            : await materializePreparedRuntimeModel({
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
                resolveModel,
              });
        expect(model?.id).toBe("middle");
      });
    },
  );

  it.each([
    { name: "literal row", rowProvider: provider, wireId: "middle", expected: 1100 },
    {
      name: "provider spelling",
      rowProvider: provider.toUpperCase(),
      wireId: "middle",
      expected: 1100,
    },
    { name: "logical reference", rowProvider: provider, wireId: "wire-middle", expected: 1100 },
    { name: "equivalent fallback", rowProvider: undefined, wireId: "middle", expected: 2200 },
  ])(
    "uses the captured $name for selected model media metadata",
    async ({ rowProvider, wireId, expected }) => {
      const options = createResolutionOptions();
      const row = (providerId: string, modelId: string, id: string, maxSidePx: number) => ({
        provider: providerId,
        modelId,
        model: {
          ...makeProviderModelFixture({
            provider: providerId,
            id,
            api: "openai-completions",
            baseUrl: "https://selected-model.example/v1",
          }),
          mediaInput: { image: { maxSidePx } },
        },
      });
      const config = {};
      const preparedModelRuntime = {
        catalogOwner: undefined,
        agentDir: "/tmp/selected-model-test",
        activeProjectKeys: [],
        allowGatewaySubagentBinding: false,
        config,
        observationConfig: config,
        isCurrent: () => true,
        authModes: {},
        metadataSnapshot,
        modelCatalog: { entries: [], routeVariants: [] },
        configuredRuntimeModels: [
          row("other-provider", "middle", "middle", 4400),
          row(provider, "final", "final", 2200),
          ...(rowProvider ? [row(rowProvider, "middle", wireId, 1100)] : []),
        ],
        inlineProviderModels: [],
        createStores: () => options,
      } satisfies PreparedModelRuntimeSnapshot;
      const result = await resolveModelAsync(provider, "middle", undefined, config, {
        ...options,
        modelIdSource: "selected",
        allowBundledStaticCatalogFallback: true,
        preparedModelRuntime,
      });
      expect(result.model).toMatchObject({
        id: "middle",
        mediaInput: { image: { maxSidePx: expected } },
      });
    },
  );
});
