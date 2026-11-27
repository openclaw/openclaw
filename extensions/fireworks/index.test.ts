import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it } from "vitest";
import { runSingleProviderCatalog } from "../test-support/provider-model-test-helpers.js";
import fireworksPlugin from "./index.js";
import {
  FIREWORKS_BASE_URL,
  FIREWORKS_DEFAULT_CONTEXT_WINDOW,
  FIREWORKS_DEFAULT_MAX_TOKENS,
} from "./provider-catalog.js";

describe("fireworks provider plugin", () => {
  let provider: Awaited<ReturnType<typeof registerSingleProviderPlugin>>;
  beforeEach(async () => {
    provider = await registerSingleProviderPlugin(fireworksPlugin);
  });
  it("builds the static Fireworks catalog", async () => {
    const catalog = await runSingleProviderCatalog({ catalog: provider.staticCatalog });
    expect(catalog).toMatchObject({ api: "openai-completions", baseUrl: FIREWORKS_BASE_URL });
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models?.[0]).toMatchObject({
      id: "accounts/fireworks/routers/glm-5p3-fast",
      name: "GLM 5.3 Fast",
      reasoning: true,
      input: ["text"],
      contextWindow: FIREWORKS_DEFAULT_CONTEXT_WINDOW,
      maxTokens: FIREWORKS_DEFAULT_MAX_TOKENS,
    });
  });
});
