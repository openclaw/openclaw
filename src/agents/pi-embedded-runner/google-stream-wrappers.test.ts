import { describe, expect, it } from "vitest";
import { sanitizeGoogleThinkingPayload } from "./google-stream-wrappers.js";

describe("sanitizeGoogleThinkingPayload — gemini-2.5-pro zero budget", () => {
  it("removes thinkingBudget=0 for gemini-2.5-pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("removes thinkingBudget=0 for gemini-2.5-pro with provider prefix", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "google/gemini-2.5-pro-preview" });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("removes only thinkingBudget and preserves other thinkingConfig keys", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.config.thinkingConfig).toHaveProperty("includeThoughts", true);
  });

  it("removes thinkingBudget=0 from native Google generationConfig payloads", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.generationConfig.thinkingConfig).not.toHaveProperty("thinkingBudget");
    expect(payload.generationConfig.thinkingConfig).toHaveProperty("includeThoughts", true);
  });

  it("keeps thinkingBudget=0 for gemini-2.5-flash (not thinking-required)", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-flash" });
    expect(payload.config.thinkingConfig).toHaveProperty("thinkingBudget", 0);
  });

  it("keeps positive thinkingBudget for gemini-2.5-pro", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 1000 },
      },
    };
    sanitizeGoogleThinkingPayload({ payload, modelId: "gemini-2.5-pro" });
    expect(payload.config.thinkingConfig).toHaveProperty("thinkingBudget", 1000);
  });

  it("rewrites Gemini 3 Pro budgets to thinkingLevel", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3.1-pro-preview",
      thinkingLevel: "high",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "HIGH",
    });
  });

  it("rewrites Gemini 3 Flash latest disabled budgets to minimal thinkingLevel", () => {
    const payload = {
      generationConfig: {
        thinkingConfig: { thinkingBudget: 0 },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-flash-latest",
      thinkingLevel: "off",
    });
    expect(payload.generationConfig.thinkingConfig).toEqual({
      thinkingLevel: "MINIMAL",
    });
  });

  it("fills thinkingLevel for Gemini 3 Flash negative budgets", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: -1, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "medium",
    });
    expect(payload.config.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingLevel: "MEDIUM",
    });
  });
});

describe("sanitizeGoogleThinkingPayload \u2014 inject thinkingBudget=0 on thinkingLevel=off", () => {
  it("injects thinkingBudget=0 for gemini-2.5-flash when thinkingLevel=off and no existing thinkingConfig", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash",
      thinkingLevel: "off",
    });
    expect(payload.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("injects thinkingBudget=0 for gemini-2.5-flash-lite when thinkingLevel=off", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash-lite",
      thinkingLevel: "off",
    });
    expect(payload.config.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("injects thinkingBudget=0 on native generationConfig for gemini-2.5-flash", () => {
    const payload: { generationConfig: Record<string, unknown> } = { generationConfig: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash",
      thinkingLevel: "off",
    });
    expect(payload.generationConfig.thinkingConfig).toEqual({ thinkingBudget: 0 });
  });

  it("does NOT inject thinkingBudget for gemini-2.5-pro (thinking-required)", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-pro",
      thinkingLevel: "off",
    });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("does NOT inject thinkingBudget for gemini-3-flash-preview (uses thinkingLevel)", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "off",
    });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("does NOT inject thinkingBudget for gemma-4-27b (uses thinkingLevel)", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemma-4-27b-it",
      thinkingLevel: "off",
    });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("does NOT inject thinkingBudget when thinkingLevel is not off", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash",
      thinkingLevel: "medium",
    });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });

  it("FORCES thinkingBudget=0 over an existing non-zero budget when thinkingLevel=off", () => {
    const payload = {
      config: {
        thinkingConfig: { thinkingBudget: 2048, includeThoughts: true },
      },
    };
    sanitizeGoogleThinkingPayload({
      payload,
      modelId: "gemini-2.5-flash",
      thinkingLevel: "off",
    });
    // Caller explicitly asked for thinking-off; overwrite any upstream default
    // so the provider actually runs without thinking. Other thinkingConfig
    // keys (includeThoughts etc.) are preserved.
    expect(payload.config.thinkingConfig).toEqual({
      thinkingBudget: 0,
      includeThoughts: true,
    });
  });

  it("does NOT inject when modelId is missing", () => {
    const payload: { config: Record<string, unknown> } = { config: {} };
    sanitizeGoogleThinkingPayload({
      payload,
      thinkingLevel: "off",
    });
    expect(payload.config).not.toHaveProperty("thinkingConfig");
  });
});
