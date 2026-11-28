import {
  resolveAgentModelPrimaryValue,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-onboard";
import { createLegacyProviderConfig } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import {
  applyXaiConfig,
  applyXaiOAuthConfig,
  applyXaiProviderConfig,
  XAI_DEFAULT_MODEL_REF,
} from "./onboard.js";

const apiConnection = { api: "openai-responses" as const, baseUrl: "https://api.x.ai/v1" };

describe("xai onboard", () => {
  it.each(["api-key", "oauth"])("sets the curated default for %s", (mode) => {
    const provider: ModelProviderConfig = {
      ...apiConnection,
      models: [],
      ...(mode === "oauth"
        ? { auth: "oauth" as const, baseUrl: "https://cli-chat-proxy.grok.com/v1" }
        : {}),
    };
    const cfg = mode === "oauth" ? applyXaiOAuthConfig({}, provider) : applyXaiConfig({});
    expect(cfg.models?.providers?.xai).toMatchObject(provider);
    expect(cfg.models?.providers?.xai?.models).toEqual([]);
    expect(XAI_DEFAULT_MODEL_REF).toBe("xai/grok-4.7");
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(XAI_DEFAULT_MODEL_REF);
    expect(cfg.agents?.defaults?.models?.[XAI_DEFAULT_MODEL_REF]?.alias).toBe("Grok");
  });

  it("keeps authored xAI models without pinning the curated inventory", () => {
    const legacy = createLegacyProviderConfig({
      providerId: "xai",
      api: "anthropic-messages",
      modelId: "custom-model",
      modelName: "Custom",
    });
    const xaiProvider = legacy.models?.providers?.xai;
    const template = xaiProvider?.models[0];
    if (!xaiProvider || !template) {
      throw new Error("expected xAI provider fixture");
    }
    xaiProvider.models.push(
      { ...template, id: "grok-3", name: "Grok 3" },
      { ...template, id: "grok-code-fast-1", name: "Grok Code Fast 1", reasoning: true },
      {
        ...template,
        id: "grok-4.20-beta-latest-reasoning",
        name: "Custom Moving Grok 4.20",
        reasoning: true,
      },
    );
    const provider = applyXaiProviderConfig(legacy).models?.providers?.xai;
    expect(provider).toMatchObject({ ...apiConnection, apiKey: "old-key" });
    expect(provider?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "grok-3",
      "grok-code-fast-1",
      "grok-4.20-beta-latest-reasoning",
    ]);
    expect(provider?.models.at(-1)?.name).toBe("Custom Moving Grok 4.20");
  });

  it("fills replace mode with the curated models newest first", () => {
    const provider = applyXaiProviderConfig({ models: { mode: "replace" } }).models?.providers?.xai;
    expect(provider).toMatchObject(apiConnection);
    expect(provider?.models.map((m) => m.id)).toEqual([
      "grok-4.7",
      "grok-4.6",
      "grok-4.5",
      "grok-build-0.1",
      "grok-4.3",
      "grok-4.20-0309-reasoning",
      "grok-4.20-0309-non-reasoning",
    ]);
  });
});
