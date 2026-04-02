import { describe, expect, it } from "vitest";
import {
  applyModelStudioNativeStreamingUsageCompat,
  buildModelStudioProvider,
  MODELSTUDIO_BASE_URL,
} from "./api.js";

describe("modelstudio provider catalog", () => {
  it("builds the bundled Model Studio provider defaults", () => {
    const provider = buildModelStudioProvider();

    expect(provider.baseUrl).toBe(MODELSTUDIO_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models?.length).toBeGreaterThan(0);
  });

  it("opts native Model Studio baseUrls into streaming usage only inside the extension", () => {
    const nativeProvider = applyModelStudioNativeStreamingUsageCompat(buildModelStudioProvider());
    expect(
      nativeProvider.models?.every((model) => model.compat?.supportsUsageInStreaming === true),
    ).toBe(true);

    const customProvider = applyModelStudioNativeStreamingUsageCompat({
      ...buildModelStudioProvider(),
      baseUrl: "https://proxy.example.com/v1",
    });
    expect(
      customProvider.models?.some((model) => model.compat?.supportsUsageInStreaming === true),
    ).toBe(false);
  });
});
