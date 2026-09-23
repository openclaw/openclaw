import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { applyConfiguredProviderOverrides } from "./model.configured-overrides.js";
import { createProviderRuntimeTestMock } from "./model.provider-runtime.test-support.js";
import { makeModel } from "./model.test-harness.js";

const provider = "synthetic-fixture";
const baseUrl = "https://models.example/v1";

function resolve(configuredModel?: Record<string, unknown>) {
  const discoveredModel = {
    ...makeModel("future-model"),
    provider,
    api: "openai-completions" as const,
    baseUrl,
    contextWindow: 128_000,
    contextWindowSource: "synthetic",
  } as ProviderRuntimeModel;
  const providerConfig = {
    baseUrl,
    models: configuredModel ? [{ id: "future-model", ...configuredModel }] : [],
  };
  const cfg = { models: { providers: { [provider]: providerConfig } } } as OpenClawConfig;
  return applyConfiguredProviderOverrides({
    provider,
    discoveredModel,
    providerConfig: providerConfig as never,
    modelId: "future-model",
    cfg,
    manifestAlias: { provider },
    runtimeHooks: createProviderRuntimeTestMock({ handledDynamicProviders: [] }),
  });
}

describe("configured overrides and synthetic context provenance", () => {
  it("drops the synthetic marker when config authors the context window", () => {
    const model = resolve({ contextWindow: 64_000 });
    expect(model?.contextWindow).toBe(64_000);
    expect(model?.contextWindowSource).toBeUndefined();
  });

  it("drops the synthetic marker when config authors only context tokens", () => {
    const model = resolve({ contextTokens: 50_000 });
    expect(model?.contextTokens).toBe(50_000);
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.contextWindowSource).toBeUndefined();
  });

  it("keeps the synthetic marker when the override does not author sizing", () => {
    const model = resolve({ reasoning: false });
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.contextWindowSource).toBe("synthetic");
  });

  it("keeps the synthetic marker without a configured model row", () => {
    const model = resolve();
    expect(model?.contextWindow).toBe(128_000);
    expect(model?.contextWindowSource).toBe("synthetic");
  });
});
