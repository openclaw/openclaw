import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ModelProviderConfig } from "../config/types.models.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { ProviderPlugin } from "../plugins/types.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { resolveImplicitProviders } from "./models-config.providers.implicit.js";

const fixture = vi.hoisted(() => ({ providers: [] as ProviderPlugin[] }));

vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => fixture.providers,
}));

let state: OpenClawTestState;
beforeAll(async () => {
  state = await createOpenClawTestState({ label: "implicit-catalog-outcomes" });
});
afterAll(async () => {
  await state.cleanup();
});
beforeEach(() => {
  fixture.providers = [];
});

function config(ids: string[] = ["learned"]): ModelProviderConfig {
  return {
    baseUrl: "https://catalog.example.invalid/v1",
    api: "openai-completions",
    models: ids.map((id) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 32768,
      maxTokens: 4096,
    })),
  };
}

function provider(id: string, run: NonNullable<ProviderPlugin["catalog"]>["run"]): ProviderPlugin {
  return {
    id,
    pluginId: "catalog-owner",
    label: id,
    auth: [],
    catalog: { order: "profile", run },
  };
}

async function discover(selected: string) {
  const outcomes: ProviderCatalogOutcome[] = [];
  const pluginMetadataSnapshot = createPluginMetadataSnapshotFixture({
    plugins: [
      {
        id: "catalog-owner",
        providers: ["canonical", "alias", "sibling"],
        modelCatalog: { aliases: { alias: { provider: "canonical" } } },
      },
    ],
  });
  const providers = await resolveImplicitProviders({
    agentDir: state.agentDir(),
    env: state.env,
    config: {},
    authStore: { version: 1, profiles: {} },
    pluginMetadataSnapshot,
    providerDiscoveryProviderIds: [selected],
    onProviderCatalogOutcome: (outcome) => outcomes.push(outcome),
  });
  return { providers, outcomes };
}

it.each([
  { selected: "canonical", reported: "alias" },
  { selected: "alias", reported: "canonical" },
])(
  "keeps explicit $reported authority when only $selected is selected",
  async ({ selected, reported }) => {
    const failure: ProviderCatalogOutcome = {
      provider: reported,
      profileId: "canonical:account",
      status: "unavailable",
    };
    const entry = provider("canonical", async (ctx) => {
      expect(ctx.providerIds).toEqual([selected]);
      return {
        provider: config(),
        outcomes: [
          failure,
          { provider: "sibling", profileId: "sibling:account", status: "auth-rejected" },
        ],
      };
    });
    entry.aliases = ["alias"];
    entry.hookAliases = ["sibling"];
    fixture.providers = [entry];
    const result = await discover(selected);
    expect(Object.keys(result.providers ?? {})).toEqual([selected]);
    expect(result.outcomes).toEqual([failure]);
  },
);

it("does not import a distinct sibling account outcome through a shared hook", async () => {
  const entry = provider("canonical", async (ctx) => {
    expect(ctx.providerIds).toEqual(["canonical"]);
    return {
      provider: config(),
      outcomes: [{ provider: "sibling", profileId: "sibling:account", status: "auth-rejected" }],
    };
  });
  entry.aliases = ["alias"];
  entry.hookAliases = ["sibling"];
  fixture.providers = [entry];
  const result = await discover("canonical");
  expect(Object.keys(result.providers ?? {})).toEqual(["canonical"]);
  expect(result.outcomes).toEqual([]);
});
