import { assert, describe, expect, it } from "vitest";
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

type ProducerCase = {
  name: string;
  rows: AuthoredModelRow[];
  expected: Pick<ModelDefinitionConfig, "name" | "reasoning" | "input" | "contextWindow" | "cost">;
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
const alias: AuthoredModelRow = {
  id: "legacy",
  name: "Alias",
  contextWindow: 16_000,
  reasoning: true,
  input: ["text", "image"],
};
const exact = { id: "selected", name: "Exact", contextWindow: 96_000 };
const defaultCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

describe("prepared inline row defaults", () => {
  it.each<ProducerCase>([
    {
      name: "sparse exact after alias",
      rows: [alias, exact],
      expected: {
        name: "Exact",
        reasoning: false,
        input: ["text"],
        contextWindow: 96_000,
        cost: defaultCost,
      },
    },
    {
      name: "sparse exact before alias",
      rows: [exact, alias],
      expected: {
        name: "Exact",
        reasoning: false,
        input: ["text"],
        contextWindow: 96_000,
        cost: defaultCost,
      },
    },
    {
      name: "explicit false exact",
      rows: [alias, { ...exact, reasoning: false, input: ["text"] }],
      expected: {
        name: "Exact",
        reasoning: false,
        input: ["text"],
        contextWindow: 96_000,
        cost: defaultCost,
      },
    },
    {
      name: "explicit true exact",
      rows: [
        { ...alias, reasoning: false, input: ["text"] },
        { ...exact, reasoning: true, input: ["text", "image"] },
      ],
      expected: {
        name: "Exact",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 96_000,
        cost: defaultCost,
      },
    },
    {
      name: "same-spelling cost and capability omissions",
      rows: [
        { ...exact, cost: { input: 7 } },
        {
          ...exact,
          name: "Later duplicate",
          contextWindow: 128_000,
          reasoning: true,
          input: ["image"],
          cost: { input: 9, output: 8, cacheRead: 0.5 },
        },
      ],
      expected: {
        name: "Exact",
        reasoning: true,
        input: ["image"],
        contextWindow: 96_000,
        cost: { input: 7, output: 8, cacheRead: 0.5, cacheWrite: 0 },
      },
    },
    {
      name: "one raw row",
      rows: [exact],
      expected: {
        name: "Exact",
        reasoning: false,
        input: ["text"],
        contextWindow: 96_000,
        cost: defaultCost,
      },
    },
  ])("selects $name before capabilities become runtime defaults", ({ rows, expected }) => {
    const parsed = validateConfigObjectRaw({
      models: {
        providers: {
          "row-selection-fixture": {
            api: "openai-completions",
            baseUrl: "https://fixture.invalid/v1",
            models: rows,
          },
        },
      },
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
    const expectedModel = {
      id: "selected",
      ...expected,
      api: "openai-completions",
      baseUrl: "https://fixture.invalid/v1",
    };
    expect(config.models?.providers?.["row-selection-fixture"]?.models).toMatchObject([
      { id: "selected", ...expected },
    ]);
    expect(inline).toMatchObject([expectedModel]);
    expect(configured.map(({ model }) => model)).toMatchObject([expectedModel]);
    expect(parsed.config).toEqual(source);
  });
});
