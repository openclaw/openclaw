import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

describe("openai provider policy public artifact", () => {
  it("defaults openai-codex provider configs to the Codex responses API", () => {
    expect(
      normalizeConfig({
        provider: "openai-codex",
        providerConfig: {
          baseUrl: "https://chatgpt.com/backend-api",
          models: [
            {
              id: "gpt-5.4",
              name: "GPT-5.4",
              reasoning: true,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 400_000,
              maxTokens: 128_000,
            },
          ],
        },
      }),
    ).toMatchObject({
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses",
      models: [{ id: "gpt-5.4" }],
    });
  });

  it("preserves explicit api values for openai-codex provider configs", () => {
    const providerConfig = {
      baseUrl: "https://chatgpt.com/backend-api",
      api: "openai-codex-responses" as const,
      models: [],
    };

    expect(
      normalizeConfig({
        provider: "openai-codex",
        providerConfig,
      }),
    ).toBe(providerConfig);
  });
});
