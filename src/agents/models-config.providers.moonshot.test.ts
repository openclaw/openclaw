import { describe, expect, it } from "vitest";
import {
  applyMoonshotNativeStreamingUsageCompat,
  buildMoonshotProvider,
  MOONSHOT_CN_BASE_URL,
} from "../../extensions/moonshot/api.js";
import { resolveMissingProviderApiKey } from "./models-config.providers.secrets.js";

describe("moonshot implicit provider (#33637)", () => {
  it("uses explicit CN baseUrl when provided", () => {
    const provider = {
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    };

    expect(provider.baseUrl).toBe(MOONSHOT_CN_BASE_URL);
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    expect(
      applyMoonshotNativeStreamingUsageCompat(provider).models?.[0]?.compat
        ?.supportsUsageInStreaming,
    ).toBe(true);
  });

  it("keeps streaming usage opt-in unset before the final compat pass", () => {
    const provider = {
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    };

    expect(provider.baseUrl).toBe("https://proxy.example.com/v1");
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
    expect(
      applyMoonshotNativeStreamingUsageCompat(provider).models?.[0]?.compat
        ?.supportsUsageInStreaming,
    ).toBeUndefined();
  });

  it("includes moonshot when MOONSHOT_API_KEY is configured", () => {
    const provider = resolveMissingProviderApiKey({
      providerKey: "moonshot",
      provider: buildMoonshotProvider(),
      env: { MOONSHOT_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
      profileApiKey: undefined,
    });

    expect(provider.apiKey).toBe("MOONSHOT_API_KEY");
    expect(provider.models?.[0]?.compat?.supportsUsageInStreaming).toBeUndefined();
  });
});
