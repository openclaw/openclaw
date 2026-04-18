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
});
