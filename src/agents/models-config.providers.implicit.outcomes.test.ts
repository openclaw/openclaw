import { expect, it, vi } from "vitest";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

const fixture = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => fixture.providers,
}));

it("keeps canonical outcome authority when only its alias is selected", async () => {
  await withOpenClawTestState({ label: "implicit-catalog-outcomes" }, async (state) => {
    const failure: ProviderCatalogOutcome = {
      provider: "canonical",
      profileId: "canonical:account",
      status: "unavailable",
    };
    fixture.providers = [
      {
        id: "canonical",
        pluginId: "catalog-owner",
        label: "canonical",
        auth: [],
        aliases: ["alias"],
        hookAliases: ["sibling"],
        catalog: {
          order: "profile",
          run: async (ctx) => {
            expect(ctx.providerIds).toEqual(["alias"]);
            return {
              provider: {
                baseUrl: "https://catalog.example.invalid/v1",
                api: "openai-completions",
                models: [
                  {
                    id: "learned",
                    name: "learned",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 32768,
                    maxTokens: 4096,
                  },
                ],
              },
              outcomes: [
                failure,
                { provider: "sibling", profileId: "sibling:account", status: "auth-rejected" },
              ],
            };
          },
        },
      },
    ];
    const outcomes: ProviderCatalogOutcome[] = [];
    const providers = await resolveImplicitProviders({
      agentDir: state.agentDir(),
      env: state.env,
      config: {},
      authStore: { version: 1, profiles: {} },
      pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
        plugins: [
          {
            id: "catalog-owner",
            providers: ["canonical", "alias", "sibling"],
            modelCatalog: { aliases: { alias: { provider: "canonical" } } },
          },
        ],
      }),
      providerDiscoveryProviderIds: ["alias"],
      onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
    });
    expect(Object.keys(providers ?? {})).toEqual(["alias"]);
    expect(outcomes).toEqual([failure]);
  });
});
