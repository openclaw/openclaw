import { expect, it, vi } from "vitest";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import { validateConfigObjectRaw } from "../config/validation-core.js";
import {
  PREPARED_THINKING_POLICY,
  type ThinkingCatalogPolicyCarrier,
} from "../plugins/provider-thinking-catalog.js";
import { overlayConfiguredModelCatalog } from "./model-catalog.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";

vi.mock("../plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: vi.fn(),
}));

const identity = { provider: "custom", id: "plain", name: "Captured model" };
const capturedMetadata = {
  ...identity,
  api: "openai-responses",
  reasoning: true,
  thinkingLevelMap: { high: "high" },
  contextWindows: [{ id: "large", label: "Large", contextWindow: 32_000 }],
  contextWindowDefault: "large",
  params: { captured: true },
  compat: { supportsTools: false },
} satisfies ModelCatalogEntry;
const defaults: Pick<ModelProviderConfig, "api" | "baseUrl"> = {
  api: "openai-completions",
  baseUrl: "https://configured.example.test/v1",
};
function config<T extends Partial<ModelDefinitionConfig>>(model: T, route = defaults) {
  return {
    plugins: { enabled: false },
    models: { providers: { custom: { ...route, models: [model] } } },
  };
}

it("clears captured capabilities when applying a previously missing base URL", () => {
  const route = { ...defaults, api: "openai-responses" } as const;
  const source = validateConfigObjectRaw(
    config({ id: "plain", name: "Configured model", ...route }, route),
  );
  if (!source.ok) {
    throw new Error(JSON.stringify(source.issues));
  }
  const captured: ModelCatalogEntry & ThinkingCatalogPolicyCarrier = {
    ...capturedMetadata,
    thinkingPolicyProvider: "captured-policy",
    [PREPARED_THINKING_POLICY]: {
      resolve: () => ({ levels: [{ id: "high" }], defaultLevel: "high" }),
    },
    contextWindow: 32_000,
    contextTokens: 16_000,
    input: ["text", "image"],
    mediaInput: { image: { maxBytes: 4_096 } },
  };
  const catalog = Object.freeze([Object.freeze(captured)]);
  const [entry] = overlayConfiguredModelCatalog({ catalog, config: source.config });
  expect(entry).toEqual({ ...identity, ...route, compat: undefined });
  expect(catalog).toEqual([captured]);
  expect(captured.thinkingLevelMap).toEqual({ high: "high" });
});

it("keeps capabilities with their captured route when provider defaults differ", () => {
  const captured: ModelCatalogEntry = Object.freeze({
    ...capturedMetadata,
    baseUrl: "https://captured.example.test/v1",
  });
  const catalog = Object.freeze([captured]);
  const [entry] = overlayConfiguredModelCatalog({
    catalog,
    config: config({
      id: "plain",
      name: "Configured model",
      reasoning: false,
      thinkingLevelMap: { high: null },
      contextWindow: 8192,
      maxTokens: 2048,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { supportsTools: true },
    }),
  });
  expect(entry).toMatchObject({
    api: captured.api,
    baseUrl: captured.baseUrl,
    reasoning: false,
    configuredReasoning: false,
    thinkingLevelMap: { high: null },
    compat: { supportsTools: false },
    contextWindows: captured.contextWindows,
    contextWindowDefault: "large",
    params: captured.params,
  });
  expect(catalog).toEqual([captured]);
  expect(captured).toMatchObject({ reasoning: true, thinkingLevelMap: { high: "high" } });
});
