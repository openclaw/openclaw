import { describe, expect, it } from "vitest";
import { normalizeConfig } from "./provider-policy-api.js";

describe("arcee provider policy public artifact", () => {
  it("normalizes stale OpenRouter base URLs and Trinity compat without loading the full plugin", () => {
    expect(
      normalizeConfig({
        provider: "arcee",
        providerConfig: {
          api: "openai-completions",
          baseUrl: "https://openrouter.ai/v1/",
          models: [
            {
              id: "arcee/trinity-large-thinking",
              name: "Trinity Large Thinking",
              reasoning: true,
              input: ["text"],
              contextWindow: 262144,
              maxTokens: 80000,
              cost: {
                input: 0.25,
                output: 0.9,
                cacheRead: 0.25,
                cacheWrite: 0.25,
              },
              compat: {
                supportsReasoningEffort: false,
                supportsStrictMode: true,
              },
            },
          ],
        },
      }),
    ).toMatchObject({
      baseUrl: "https://openrouter.ai/api/v1",
      models: [
        {
          id: "arcee/trinity-large-thinking",
          compat: {
            supportsReasoningEffort: false,
            supportsStrictMode: true,
            supportsTools: false,
          },
        },
      ],
    });
  });

  it("returns unchanged non-Trinity configs by identity", () => {
    const providerConfig = {
      api: "openai-completions",
      baseUrl: "https://api.arcee.ai/api/v1",
      models: [
        {
          id: "trinity-mini",
          name: "Trinity Mini 26B",
          reasoning: false,
          input: ["text"],
          contextWindow: 131072,
          maxTokens: 80000,
          cost: {
            input: 0.045,
            output: 0.15,
            cacheRead: 0.045,
            cacheWrite: 0.045,
          },
        },
      ],
    } satisfies Parameters<typeof normalizeConfig>[0]["providerConfig"];

    expect(normalizeConfig({ provider: "arcee", providerConfig })).toBe(providerConfig);
  });
});
