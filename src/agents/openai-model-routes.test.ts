import { describe, expect, it } from "vitest";
import { resolveOpenAIModelRoutes } from "./openai-model-routes.js";

describe("OpenAI model route facts", () => {
  it("normalizes provider ids and profile-qualified model refs", () => {
    expect(
      resolveOpenAIModelRoutes({
        provider: "OpenAI",
        modelId: "openai/gpt-5.5@work",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        env: {},
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
        },
      ],
    });
  });

  it("ignores non-OpenAI providers", () => {
    expect(
      resolveOpenAIModelRoutes({ provider: "anthropic", modelId: "gpt-5.5", env: {} }),
    ).toBeNull();
  });
});
