import { beforeEach, describe, expect, it, vi } from "vitest";

describe("models-config.providers.policy", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("resolves config apiKey markers through provider runtime hooks", async () => {
    const providerRuntime = await import("../plugins/provider-runtime.js");
    vi.spyOn(providerRuntime, "resolveProviderRuntimePlugin").mockReturnValue({
      id: "amazon-bedrock",
      label: "Amazon Bedrock",
      auth: [],
      resolveConfigApiKey: () => "AWS_PROFILE",
    });
    const resolveProviderConfigApiKeyWithPluginSpy = vi
      .spyOn(providerRuntime, "resolveProviderConfigApiKeyWithPlugin")
      .mockReturnValue("AWS_PROFILE");

    const { resolveProviderConfigApiKeyResolver } =
      await import("./models-config.providers.policy.js");
    const env = {
      AWS_PROFILE: "default",
    } as NodeJS.ProcessEnv;
    const resolver = resolveProviderConfigApiKeyResolver("amazon-bedrock");

    expect(resolver).toBeTypeOf("function");
    expect(resolver?.(env)).toBe("AWS_PROFILE");
    expect(resolveProviderConfigApiKeyWithPluginSpy).toHaveBeenCalledWith({
      provider: "amazon-bedrock",
      env,
      context: {
        provider: "amazon-bedrock",
        env,
      },
    });
  });
});
