import { describe, it, expect } from "vitest";
import {
  isZaiVisionModel,
  isCodingBaseUrl,
  toStandardBaseUrl,
  patchCfgForVisionModel,
} from "./media-understanding-provider.js";

describe("isZaiVisionModel", () => {
  it("returns true for known vision models", () => {
    expect(isZaiVisionModel("glm-4.6v")).toBe(true);
    expect(isZaiVisionModel("glm-4.5v")).toBe(true);
    expect(isZaiVisionModel("glm-5v-turbo")).toBe(true);
  });

  it("returns false for non-vision models", () => {
    expect(isZaiVisionModel("glm-5.1")).toBe(false);
    expect(isZaiVisionModel("glm-4.7")).toBe(false);
    expect(isZaiVisionModel("glm-4.6")).toBe(false);
  });
});

describe("isCodingBaseUrl", () => {
  it("detects coding endpoints", () => {
    expect(isCodingBaseUrl("https://api.z.ai/api/coding/paas/v4")).toBe(true);
    expect(isCodingBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(true);
    expect(isCodingBaseUrl("https://api.z.ai/api/coding/paas/v5")).toBe(true);
  });

  it("returns false for standard endpoints", () => {
    expect(isCodingBaseUrl("https://api.z.ai/api/paas/v4")).toBe(false);
    expect(isCodingBaseUrl("https://open.bigmodel.cn/api/paas/v4")).toBe(false);
  });
});

describe("toStandardBaseUrl", () => {
  it("converts global coding endpoint to standard", () => {
    expect(toStandardBaseUrl("https://api.z.ai/api/coding/paas/v4")).toBe(
      "https://api.z.ai/api/paas/v4",
    );
  });

  it("converts CN coding endpoint to standard", () => {
    expect(toStandardBaseUrl("https://open.bigmodel.cn/api/coding/paas/v4")).toBe(
      "https://open.bigmodel.cn/api/paas/v4",
    );
  });

  it("converts v5 coding endpoint to standard", () => {
    expect(toStandardBaseUrl("https://api.z.ai/api/coding/paas/v5")).toBe(
      "https://api.z.ai/api/paas/v5",
    );
  });
});

describe("patchCfgForVisionModel", () => {
  function makeParams(provider: string, model: string, baseUrl: string) {
    return {
      provider,
      model,
      cfg: {
        models: {
          providers: {
            zai: { baseUrl },
          },
        },
      },
    };
  }

  it("patches coding baseUrl for ZAI vision model", () => {
    const params = makeParams("zai", "glm-4.6v", "https://api.z.ai/api/coding/paas/v4");
    const patched = patchCfgForVisionModel(params);
    const patchedBaseUrl = (patched.cfg as Record<string, unknown>).models
      ? (
          (patched.cfg as Record<string, Record<string, unknown>>).models.providers as Record<
            string,
            Record<string, unknown>
          >
        ).zai.baseUrl
      : undefined;
    expect(patchedBaseUrl).toBe("https://api.z.ai/api/paas/v4");
  });

  it("does not patch standard baseUrl", () => {
    const params = makeParams("zai", "glm-4.6v", "https://api.z.ai/api/paas/v4");
    const patched = patchCfgForVisionModel(params);
    expect(patched).toBe(params);
  });

  it("does not patch non-vision model", () => {
    const params = makeParams("zai", "glm-5.1", "https://api.z.ai/api/coding/paas/v4");
    const patched = patchCfgForVisionModel(params);
    expect(patched).toBe(params);
  });

  it("does not patch non-ZAI provider", () => {
    const params = makeParams("openai", "gpt-4.6v", "https://api.z.ai/api/coding/paas/v4");
    const patched = patchCfgForVisionModel(params);
    expect(patched).toBe(params);
  });
});
