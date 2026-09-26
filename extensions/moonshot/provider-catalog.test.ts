import { useProviderCatalogMetadata } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  applyMoonshotNativeStreamingUsageCompat,
  buildMoonshotProvider,
  MOONSHOT_CN_BASE_URL,
} from "./api.js";

useProviderCatalogMetadata(new URL(".", import.meta.url));

type MoonshotProvider = ReturnType<typeof buildMoonshotProvider>;
type MoonshotModel = MoonshotProvider["models"][number];

function requireFirstMoonshotModel(provider: MoonshotProvider): MoonshotModel {
  const model = provider.models[0];
  if (!model) {
    throw new Error("expected first Moonshot model");
  }
  return model;
}

describe("moonshot provider catalog", () => {
  it("opts native Moonshot baseUrls into streaming usage only inside the extension", () => {
    const defaultProvider = applyMoonshotNativeStreamingUsageCompat(buildMoonshotProvider());
    expect(requireFirstMoonshotModel(defaultProvider).compat?.supportsUsageInStreaming).toBe(true);

    const cnProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: MOONSHOT_CN_BASE_URL,
    });
    expect(requireFirstMoonshotModel(cnProvider).compat?.supportsUsageInStreaming).toBe(true);

    const customProvider = applyMoonshotNativeStreamingUsageCompat({
      ...buildMoonshotProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      "supportsUsageInStreaming" in (requireFirstMoonshotModel(customProvider).compat ?? {}),
    ).toBe(false);
  });
});
