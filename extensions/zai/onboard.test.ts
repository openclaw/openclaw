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

  it("backfills vision baseUrl for configs onboarded before the fix", () => {
    // Simulate a stale config: coding endpoint already configured, vision
    // models present without baseUrl (the buggy pre-fix shape).
    const stale = applyZaiConfig({}, { endpoint: "coding-global" });
    const staleZai = stale.models?.providers?.zai;
    const stripped = {
      ...stale,
      models: {
        ...stale.models,
        providers: {
          ...stale.models?.providers,
          zai: {
            ...staleZai,
            models: (staleZai?.models ?? []).map(({ baseUrl: _drop, ...rest }) => rest),
          },
        },
      },
    };
    const cfg = applyZaiConfig(stripped, { endpoint: "coding-global" });
    const byId = new Map((cfg.models?.providers?.zai?.models ?? []).map((m) => [m.id, m]));
    expect(byId.get("glm-4.6v")?.baseUrl).toBe(ZAI_GLOBAL_BASE_URL);
    expect(byId.get("glm-4.5v")?.baseUrl).toBe(ZAI_GLOBAL_BASE_URL);
    expect(byId.get("glm-5v-turbo")?.baseUrl).toBe(ZAI_GLOBAL_BASE_URL);
  });

  it("preserves user-defined custom image-capable zai models during re-onboarding", () => {
    // A user-added Z.AI model that isn't part of the bundled catalog must keep
    // its pinned baseUrl across endpoint changes. Only the bundled vision ids
    // (glm-4.6v / glm-4.5v / glm-5v-turbo) are managed by onboarding.
    const seed = applyZaiConfig({}, { endpoint: "coding-global" });
    const zai = seed.models?.providers?.zai;
    const customModel = {
      id: "acme-vision-custom",
      name: "ACME Vision",
      api: "openai-completions" as const,
      input: ["text", "image"] as const,
      output: ["text"] as const,
      baseUrl: "https://acme.example.com/v1",
    };
    const withCustom = {
      ...seed,
      models: {
        ...seed.models,
        providers: {
          ...seed.models?.providers,
          zai: { ...zai, models: [...(zai?.models ?? []), customModel] },
        },
      },
    };
    const switched = applyZaiConfig(withCustom, { endpoint: "global" });
    const byId = new Map((switched.models?.providers?.zai?.models ?? []).map((m) => [m.id, m]));
    expect(byId.get("acme-vision-custom")?.baseUrl).toBe("https://acme.example.com/v1");
    expect(byId.get("glm-4.6v")?.baseUrl).toBeUndefined();
  });

  it("rewrites stale vision baseUrl when switching between endpoints", () => {
    const first = applyZaiConfig({}, { endpoint: "coding-global" });
    const second = applyZaiConfig(first, { endpoint: "coding-cn" });
    const byCodingCn = new Map((second.models?.providers?.zai?.models ?? []).map((m) => [m.id, m]));
    expect(second.models?.providers?.zai?.baseUrl).toBe(ZAI_CODING_CN_BASE_URL);
    expect(byCodingCn.get("glm-4.6v")?.baseUrl).toBe(ZAI_CN_BASE_URL);
    expect(byCodingCn.get("glm-4.5v")?.baseUrl).toBe(ZAI_CN_BASE_URL);

    const third = applyZaiConfig(second, { endpoint: "global" });
    const byGlobal = new Map((third.models?.providers?.zai?.models ?? []).map((m) => [m.id, m]));
    expect(third.models?.providers?.zai?.baseUrl).toBe(ZAI_GLOBAL_BASE_URL);
    expect(byGlobal.get("glm-4.6v")?.baseUrl).toBeUndefined();
    expect(byGlobal.get("glm-4.5v")?.baseUrl).toBeUndefined();
  });
});
