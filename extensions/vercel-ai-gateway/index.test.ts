import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import {
  VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
  VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
} from "./api.js";
import plugin from "./index.js";

describe("vercel ai gateway provider hooks", () => {
  it("resolves live-only model ids for the embedded runner", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const model = provider.resolveDynamicModel?.({
      provider: "vercel-ai-gateway",
      modelId: "custom/provider-model",
      modelRegistry: { find: () => null },
    } as never);

    expect(model).toEqual({
      id: "custom/provider-model",
      name: "custom/provider-model",
      reasoning: false,
      input: ["text"],
      contextWindow: VERCEL_AI_GATEWAY_DEFAULT_CONTEXT_WINDOW,
      maxTokens: VERCEL_AI_GATEWAY_DEFAULT_MAX_TOKENS,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      provider: "vercel-ai-gateway",
      api: "anthropic-messages",
      baseUrl: "https://ai-gateway.vercel.sh",
    });
  });
});
