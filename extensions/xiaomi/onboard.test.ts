import { describe, expect, it } from "vitest";
import { resolveAgentModelPrimaryValue } from "../../src/config/model-input.js";
import { createLegacyProviderConfig } from "../../test/helpers/extensions/onboard-config.js";
import { applyXiaomiConfig, applyXiaomiProviderConfig } from "./onboard.js";

describe("xiaomi onboard", () => {
  it("adds Xiaomi provider with correct settings", () => {
    const cfg = applyXiaomiConfig({});
    expect(cfg.models?.providers?.xiaomi).toMatchObject({
      baseUrl: "https://api.xiaomimimo.com/v1",
      api: "openai-completions",
    });
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe("xiaomi/mimo-v2-flash");
  });

  it("merges Xiaomi models and keeps existing provider overrides", () => {
    const cfg = applyXiaomiProviderConfig(
      createLegacyProviderConfig({
        providerId: "xiaomi",
        api: "openai-completions",
        modelId: "custom-model",
        modelName: "Custom",
      }),
    );

    expect(cfg.models?.providers?.xiaomi?.baseUrl).toBe("https://api.xiaomimimo.com/v1");
    expect(cfg.models?.providers?.xiaomi?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.xiaomi?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.xiaomi?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "mimo-v2-flash",
      "mimo-v2-pro",
      "mimo-v2-omni",
    ]);
  });
});
