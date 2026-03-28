import { describe, expect, it } from "vitest";
import { resolveAgentModelPrimaryValue } from "../../src/config/model-input.js";
import { ZAI_CODING_CN_BASE_URL, ZAI_GLOBAL_BASE_URL } from "./model-definitions.js";
import { applyZaiConfig, applyZaiProviderConfig } from "./onboard.js";

describe("zai onboard", () => {
  it("adds zai provider with correct settings", () => {
    const cfg = applyZaiConfig({});
    expect(cfg.models?.providers?.zai).toMatchObject({
      baseUrl: ZAI_GLOBAL_BASE_URL,
      api: "openai-completions",
    });
    const ids = cfg.models?.providers?.zai?.models?.map((m) => m.id);
    expect(ids).toContain("glm-5");
    expect(ids).toContain("glm-5.1");
    expect(ids).toContain("glm-5-turbo");
    expect(ids).toContain("glm-4.7");
    expect(ids).toContain("glm-4.7-flash");
    expect(ids).toContain("glm-4.7-flashx");
  });

  it("supports CN endpoint for supported coding models", () => {
    for (const modelId of ["glm-4.7-flash", "glm-4.7-flashx"] as const) {
      const cfg = applyZaiConfig({}, { endpoint: "coding-cn", modelId });
      expect(cfg.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
      expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(`zai/${modelId}`);
    }
  });

  it("does not overwrite existing primary model in provider-only mode", () => {
    const cfg = applyZaiProviderConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe(
      "anthropic/claude-opus-4-5",
    );
  });

  it("supports GLM-5.1 as an onboarding-selected model", () => {
    const cfg = applyZaiConfig({}, { endpoint: "coding-global", modelId: "glm-5.1" });
    expect(resolveAgentModelPrimaryValue(cfg.agents?.defaults?.model)).toBe("zai/glm-5.1");
    expect(cfg.models?.providers?.zai?.baseUrl).toBe("https://api.z.ai/api/coding/paas/v4");
    expect(cfg.models?.providers?.zai?.models?.map((m) => m.id)).toContain("glm-5.1");
  });
});
