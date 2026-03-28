import { describe, expect, it } from "vitest";
import { createLegacyProviderConfig } from "../../test/helpers/extensions/onboard-config.js";
import { applyLitellmProviderConfig } from "./onboard.js";

describe("litellm onboard", () => {
  it("preserves existing baseUrl and api key while adding the default model", () => {
    const cfg = applyLitellmProviderConfig(
      createLegacyProviderConfig({
        providerId: "litellm",
        api: "anthropic-messages",
        modelId: "custom-model",
        modelName: "Custom",
        baseUrl: "https://litellm.example/v1",
        apiKey: "  old-key  ",
      }),
    );

    expect(cfg.models?.providers?.litellm?.baseUrl).toBe("https://litellm.example/v1");
    expect(cfg.models?.providers?.litellm?.api).toBe("openai-completions");
    expect(cfg.models?.providers?.litellm?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.litellm?.models.map((m) => m.id)).toEqual([
      "custom-model",
      "claude-opus-4-6",
    ]);
  });
});
