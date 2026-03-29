import { describe, expect, it } from "vitest";

describe("models-config.providers.policy", () => {
  it("resolves config apiKey markers through provider plugin hooks", async () => {
    const { resolveProviderConfigApiKeyResolver } =
      await import("./models-config.providers.policy.js");
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;
    const resolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");

    expect(resolver).toBeTypeOf("function");
    expect(resolver?.(env)).toBe("AWS_PROFILE");
  });

  it("resolves anthropic-vertex ADC markers through provider plugin hooks", async () => {
    const { resolveProviderConfigApiKeyResolver } =
      await import("./models-config.providers.policy.js");
    const resolver = resolveProviderConfigApiKeyResolver("anthropic-vertex");

    expect(resolver).toBeTypeOf("function");
    expect(
      resolver?.({
        ANTHROPIC_VERTEX_USE_GCP_METADATA: "true",
      } as NodeJS.ProcessEnv),
    ).toBe("gcp-vertex-credentials");
  });

  it("normalizes Google provider config through provider plugin hooks", async () => {
    const { normalizeProviderSpecificConfig } = await import("./models-config.providers.policy.js");

    expect(
      normalizeProviderSpecificConfig("google", {
        api: "google-generative-ai",
        baseUrl: "https://generativelanguage.googleapis.com",
        models: [],
      }),
    ).toMatchObject({
      api: "google-generative-ai",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    });
  });
});
