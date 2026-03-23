import { describe, expect, it } from "vitest";
import { hasOpenRouterStrictToolSupportRoute } from "./openai-strict-tool-support.js";

describe("hasOpenRouterStrictToolSupportRoute", () => {
  it("keeps strict mode for OpenRouter OpenAI routes pinned to Azure", () => {
    expect(
      hasOpenRouterStrictToolSupportRoute({
        id: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {
          openRouterRouting: {
            order: ["azure"],
            allowFallbacks: false,
          },
        },
      }),
    ).toBe(true);
  });

  it("strips strict mode for non-OpenAI OpenRouter routes pinned to Azure", () => {
    expect(
      hasOpenRouterStrictToolSupportRoute({
        id: "mistralai/mistral-large",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {
          openRouterRouting: {
            order: ["azure"],
            allowFallbacks: false,
          },
        },
      }),
    ).toBe(false);
  });

  it("keeps strict mode for OpenRouter endpoint slugs pinned to OpenAI", () => {
    expect(
      hasOpenRouterStrictToolSupportRoute({
        id: "openai/gpt-4o",
        baseUrl: "https://openrouter.ai/api/v1",
        compat: {
          openRouterRouting: {
            order: ["openai/turbo"],
            allowFallbacks: false,
          },
        },
      }),
    ).toBe(true);
  });
});
