import { assert, expect, it } from "vitest";
import { applyModelDefaults } from "../config/defaults.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import { buildInlineProviderModels } from "./embedded-agent-runner/model.inline-provider.js";
import { createStaticModelIdMatcher } from "./embedded-agent-runner/model.static-id.js";
import { prepareConfiguredRuntimeModels } from "./prepared-model-runtime.configured.js";

type AuthoredModelRow = Pick<ModelDefinitionConfig, "id" | "name"> &
  Partial<Omit<ModelDefinitionConfig, "id" | "name" | "cost">> & {
    cost?: Partial<ModelDefinitionConfig["cost"]>;
  };

const metadata = createPluginMetadataSnapshotFixture({
  plugins: [
    {
      id: "row-selection-fixture",
      providers: ["row-selection-fixture"],
      modelIdNormalization: {
        providers: { "row-selection-fixture": { aliases: { legacy: "selected" } } },
      },
    },
  ],
});
const exact = { id: "selected", name: "Exact", contextWindow: 96_000 };
const expectedDefaults = {
  ...exact,
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

it.each([false, true])("selects rows before applying defaults (duplicate: %s)", (duplicate) => {
  const alias: AuthoredModelRow = {
    id: "legacy",
    name: "Alias",
    contextWindow: 16_000,
    reasoning: true,
    input: ["text", "image"],
  };
  const later: AuthoredModelRow = {
    ...exact,
    name: "Later duplicate",
    contextWindow: 128_000,
    reasoning: true,
    input: ["image"],
    cost: { input: 9, output: 8, cacheRead: 0.5 },
  };
  const rows = duplicate ? [{ ...exact, cost: { input: 7 } }, later] : [alias, exact];
  const expected = duplicate
    ? {
        ...expectedDefaults,
        reasoning: true,
        input: ["image"],
        cost: { input: 7, output: 8, cacheRead: 0.5, cacheWrite: 0 },
      }
    : expectedDefaults;
  const provider = { api: "openai-completions" as const, baseUrl: "https://fixture.invalid/v1" };
  const parsed = validateConfigObjectRaw({
    models: { providers: { "row-selection-fixture": { ...provider, models: rows } } },
  });
  assert(parsed.ok);
  const source = structuredClone(parsed.config);
  const config = applyModelDefaults(parsed.config, {
    manifestRegistry: metadata.manifestRegistry,
  });
  const inline = buildInlineProviderModels(config.models?.providers ?? {}, {
    providerMetadataOwners: metadata.owners,
  });
  const configured = prepareConfiguredRuntimeModels({
    config,
    inlineProviderModels: inline,
    configuredModelRefs: [{ provider: "row-selection-fixture", modelId: "selected" }],
    metadataSnapshot: metadata,
    providerStaticModels: [],
    resolveStaticCatalogModel: () => undefined,
    matchesStaticModelId: createStaticModelIdMatcher({ manifestPlugins: metadata }),
  });
  const expectedModel = { ...expected, ...provider };
  expect(config.models?.providers?.["row-selection-fixture"]?.models).toMatchObject([expected]);
  expect(inline).toMatchObject([expectedModel]);
  expect(configured.map(({ model }) => model)).toMatchObject([expectedModel]);
  expect(parsed.config).toEqual(source);
});
