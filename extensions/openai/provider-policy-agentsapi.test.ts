import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelRoutes } from "./provider-policy-api.js";

describe("Agents API provider routes", () => {
  beforeEach(() => vi.stubEnv("OPENAI_BASE_URL", ""));
  afterEach(() => vi.unstubAllEnvs());

  it.each(["gpt-6-astra", "future-model"])(
    "allows the configured Agents API route for %s",
    (modelId) => {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          configuredProvider: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        }),
      ).toMatchObject({
        kind: "routes",
        routes: [{ runtimePolicy: { compatibleIds: ["openclaw", "codex", "agentsapi"] } }],
      });
    },
  );
});
