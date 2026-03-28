import { describe, expect, it } from "vitest";

describe("models-config.providers.policy", () => {
  it("resolves config apiKey markers through the local bedrock helper", async () => {
    const { resolveProviderConfigApiKeyResolver } =
      await import("./models-config.providers.policy.js");
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;
    const resolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");

    expect(resolver).toBeTypeOf("function");
    expect(resolver?.(env)).toBe("AWS_PROFILE");
  });
});
