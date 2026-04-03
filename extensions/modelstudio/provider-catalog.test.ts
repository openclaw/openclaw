import { describe, expect, it } from "vitest";
import {
  applyModelStudioNativeStreamingUsageCompat,
  buildModelStudioProvider,
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_MODEL_ID,
} from "./api.js";

describe("modelstudio provider catalog", () => {
  it("builds the bundled Model Studio provider defaults", () => {
    const provider = buildModelStudioProvider();

    expect(provider.baseUrl).toBe(MODELSTUDIO_BASE_URL);
    expect(provider.api).toBe("openai-completions");
    expect(provider.models?.length).toBeGreaterThan(0);
    expect(
      provider.models?.find((model) => model.id === MODELSTUDIO_DEFAULT_MODEL_ID),
    ).toBeTruthy();
    expect(provider.models?.find((model) => model.id === "qwen3.6-plus")).toBeTruthy();
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
