import { describe, expect, it } from "vitest";
import { resolveModelRoutes } from "./provider-policy-api.js";

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
};
const subscriptionRoute = {
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api/codex",
  authRequirement: "subscription",
};

describe("OpenAI stale ChatGPT catalog rows", () => {
  it.each([
    ["gpt-6.1-sol", [platformRoute, subscriptionRoute]],
    ["gpt-5.4-codex", [platformRoute, subscriptionRoute]],
    ["chat-latest", [platformRoute]],
    ["gpt-5.3-codex-spark", [subscriptionRoute]],
  ] as const)("keeps the official route contract for %s", (modelId, routes) => {
    const observedRoutes = [
      { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
      {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://observed-relay.example.test/v1",
      },
    ] as const;
    for (const observed of [observedRoutes, [observedRoutes[1]]]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          env: {},
          observedRoutes: observed,
        }),
      ).toMatchObject({ kind: "routes", routes });
    }
  });
});
