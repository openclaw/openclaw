import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

describe("deepinfra provider policy public artifact", () => {
  it("preserves the DeepInfra mid-path /v1 baseUrl without appending another /v1", () => {
    const providerConfig: ModelProviderConfig = {
      baseUrl: "https://api.deepinfra.com/v1/openai",
      api: "openai-completions",
      models: [],
    };

    const normalized = normalizeConfig({ provider: "deepinfra", providerConfig });

    expect(normalized.baseUrl).toBe("https://api.deepinfra.com/v1/openai");
    expect(normalized.baseUrl).not.toMatch(/\/v1\/openai\/v1$/);
  });
});
