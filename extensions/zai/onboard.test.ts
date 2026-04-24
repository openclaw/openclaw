import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it } from "vitest";
import { expectProviderOnboardPreservesPrimary } from "../../test/helpers/plugins/provider-onboard.js";
import {
  ZAI_CN_BASE_URL,
  ZAI_CODING_CN_BASE_URL,
  ZAI_CODING_GLOBAL_BASE_URL,
  ZAI_GLOBAL_BASE_URL,
} from "./model-definitions.js";
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
    expectProviderOnboardPreservesPrimary({
      applyProviderConfig: applyZaiProviderConfig,
      primaryModelRef: "anthropic/claude-opus-4-5",
    });
  });

  it("routes vision models to the non-coding host when onboarded to a Coding Plan endpoint", () => {
    // Vision models (glm-4.6v, glm-4.5v, glm-5v-turbo) are unavailable on
    // the Z.AI Coding Plan endpoints and return 404 there. They must point
    // at the matching non-coding host so the built-in `image` tool works.
    for (const [endpoint, provider, vision] of [
      ["coding-global", ZAI_CODING_GLOBAL_BASE_URL, ZAI_GLOBAL_BASE_URL],
      ["coding-cn", ZAI_CODING_CN_BASE_URL, ZAI_CN_BASE_URL],
    ] as const) {
      const cfg = applyZaiConfig({}, { endpoint });
      const zai = cfg.models?.providers?.zai;
      expect(zai?.baseUrl).toBe(provider);
      const byId = new Map((zai?.models ?? []).map((m) => [m.id, m]));
      for (const visionId of ["glm-4.6v", "glm-4.5v", "glm-5v-turbo"] as const) {
        expect(byId.get(visionId)?.baseUrl).toBe(vision);
      }
      expect(byId.get("glm-5.1")?.baseUrl).toBeUndefined();
      expect(byId.get("glm-4.7-flash")?.baseUrl).toBeUndefined();
    }
  });

  it("does not override vision model baseUrl when onboarded to non-coding endpoints", () => {
    for (const endpoint of ["global", "cn"] as const) {
      const cfg = applyZaiConfig({}, { endpoint });
      const zai = cfg.models?.providers?.zai;
      const visionEntries = (zai?.models ?? []).filter((m) => m.input?.includes("image"));
      expect(visionEntries.length).toBeGreaterThan(0);
      for (const entry of visionEntries) {
        expect(entry.baseUrl).toBeUndefined();
      }
    }
  });
});
