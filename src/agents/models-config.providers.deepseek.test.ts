import { describe, expect, it } from "vitest";
import { buildDeepSeekProvider } from "./models-config.providers.static.js";

describe("DeepSeek plugin registration", () => {
  it("should be discoverable as a plugin provider with auth methods", async () => {
    const { resolvePluginProviders } = await import("../plugins/providers.js");
    const { resolveProviderPluginChoice } = await import("../plugins/provider-wizard.js");
    const providers = resolvePluginProviders({
      bundledProviderAllowlistCompat: true,
      bundledProviderVitestCompat: true,
      cache: false,
    });
    const deepseek = providers.find((p) => p.id === "deepseek");
    expect(deepseek).toBeDefined();
    expect(deepseek!.auth.length).toBeGreaterThan(0);

    const resolved = resolveProviderPluginChoice({ providers, choice: "deepseek-api-key" });
    expect(resolved).not.toBeNull();
    expect(resolved!.provider.id).toBe("deepseek");
    expect(resolved!.method.id).toBe("api-key");
  });
});

describe("DeepSeek provider", () => {
  it("should build deepseek provider with correct configuration", () => {
    const provider = buildDeepSeekProvider();
    expect(provider.baseUrl).toBe("https://api.deepseek.com");
    expect(provider.api).toBe("openai-completions");
    expect(provider.models).toBeDefined();
    expect(provider.models.length).toBeGreaterThan(0);
  });

  it("should include both deepseek-chat and deepseek-reasoner models", () => {
    const provider = buildDeepSeekProvider();
    const modelIds = provider.models.map((m) => m.id);
    expect(modelIds).toContain("deepseek-chat");
    expect(modelIds).toContain("deepseek-reasoner");
  });

  it("should mark deepseek-reasoner as a reasoning model", () => {
    const provider = buildDeepSeekProvider();
    const reasoner = provider.models.find((m) => m.id === "deepseek-reasoner");
    const chat = provider.models.find((m) => m.id === "deepseek-chat");
    expect(reasoner?.reasoning).toBe(true);
    expect(chat?.reasoning).toBe(false);
  });
});
