import { describe, expect, it } from "vitest";
import {
  applyNativeStreamingUsageCompat,
  buildModelStudioProvider,
} from "./models-config.providers.js";

describe("Model Studio implicit provider", () => {
  it("should opt native Model Studio baseUrls into streaming usage", () => {
    const providers = applyNativeStreamingUsageCompat({
      modelstudio: buildModelStudioProvider(),
    });
    expect(providers?.modelstudio).toBeDefined();
    expect(providers?.modelstudio?.baseUrl).toBe("https://coding-intl.dashscope.aliyuncs.com/v1");
    expect(
      providers?.modelstudio?.models?.every(
        (model) => model.compat?.supportsUsageInStreaming === true,
      ),
    ).toBe(true);
  });

  it("should keep streaming usage opt-in disabled for custom Model Studio-compatible baseUrls", () => {
    const providers = applyNativeStreamingUsageCompat({
      modelstudio: {
        ...buildModelStudioProvider(),
        baseUrl: "https://proxy.example.com/v1",
      },
    });
    expect(providers?.modelstudio).toBeDefined();
    expect(providers?.modelstudio?.baseUrl).toBe("https://proxy.example.com/v1");
    expect(
      providers?.modelstudio?.models?.some(
        (model) => model.compat?.supportsUsageInStreaming === true,
      ),
    ).toBe(false);
  });
});
