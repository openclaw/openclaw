import {
  registerSingleProviderPlugin,
  resolveProviderPluginChoice,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import nearAIPlugin from "./index.js";
import { applyNearAIConfig, NEARAI_DEFAULT_MODEL_REF } from "./onboard.js";

function expectRecord<T>(value: T | null | undefined, label: string): NonNullable<T> {
  if (!value) {
    throw new Error(`Expected ${label}`);
  }
  return value;
}

describe("nearai provider plugin", () => {
  it("registers NEAR AI Cloud with api-key auth wizard metadata", async () => {
    const provider = await registerSingleProviderPlugin(nearAIPlugin);
    const resolved = resolveProviderPluginChoice({
      providers: [provider],
      choice: "nearai-api-key",
    });

    expect(provider.id).toBe("nearai");
    expect(provider.label).toBe("NEAR AI Cloud");
    expect(provider.docsPath).toBe("/providers/nearai");
    expect(provider.envVars).toEqual(["NEARAI_API_KEY"]);
    expect(provider.auth).toHaveLength(1);
    const resolvedChoice = expectRecord(resolved, "NEAR AI provider choice");
    expect({
      providerId: resolvedChoice.provider.id,
      methodId: resolvedChoice.method.id,
    }).toEqual({
      providerId: "nearai",
      methodId: "api-key",
    });
  });

  it("builds the NEAR AI model catalog", async () => {
    const provider = await registerSingleProviderPlugin(nearAIPlugin);
    const catalogProvider = await runSingleProviderCatalog(provider);

    expect(catalogProvider.api).toBe("openai-completions");
    expect(catalogProvider.baseUrl).toBe("https://cloud-api.near.ai/v1");
    const models = expectRecord(catalogProvider.models, "NEAR AI catalog models");
    const defaultModel = expectRecord(
      models.find((model) => model.id === "zai-org/GLM-5.1-FP8"),
      "default NEAR AI model",
    );
    expect(defaultModel).toMatchObject({
      name: "GLM 5.1",
      reasoning: true,
      input: ["text"],
      contextWindow: 202752,
      maxTokens: 65536,
      compat: {
        maxTokensField: "max_tokens",
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsReasoningEffort: false,
        supportsStrictMode: false,
      },
    });
  });

  it("applies NEAR AI as the default model during onboarding", () => {
    const cfg = applyNearAIConfig({});
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      NEARAI_DEFAULT_MODEL_REF,
    );
    expect(cfg.models?.providers?.nearai?.baseUrl).toBe("https://cloud-api.near.ai/v1");
    expect(cfg.models?.providers?.nearai?.api).toBe("openai-completions");
  });
});
