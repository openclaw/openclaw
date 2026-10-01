// A first-party id outside the ChatGPT catalog keeps the Platform transport under
// the Codex runtime, and the offline catalog lists only ids with a subscription
// contract (#148559).
import { describe, expect, it } from "vitest";
import { buildOpenAIProvider } from "./openai-provider.js";

describe("buildOpenAIProvider nano route", () => {
  it("keeps a first-party id outside the ChatGPT catalog on the Platform transport under the Codex runtime", () => {
    // gpt-5.4-nano is modern but not in OPENAI_CHATGPT_MODERN_MODEL_IDS. Projecting
    // it onto the Codex transport here made it the model's only observed route,
    // and the auth planner then rejected an API key as incompatible (#148559).
    const provider = buildOpenAIProvider();
    const registry = {
      find: () => ({
        provider: "openai",
        id: "gpt-5.4-nano",
        name: "GPT-5.4 Nano",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      }),
    };
    const nano = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry,
      agentRuntimeId: "codex",
    } as never);
    expect(nano).toMatchObject({
      id: "gpt-5.4-nano",
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    // The dual-route sibling still follows the runtime onto the Codex transport.
    const mini = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-mini",
      modelRegistry: {
        find: () => ({ ...registry.find(), id: "gpt-5.4-mini", name: "GPT-5.4 Mini" }),
      },
      agentRuntimeId: "codex",
    } as never);
    expect(mini).toMatchObject({
      id: "gpt-5.4-mini",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    // An authored ChatGPT adapter still redirects nano; only the implicit
    // projection changed.
    const authored = provider.resolveDynamicModel?.({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      modelRegistry: registry,
      agentRuntimeId: "codex",
      providerConfig: { api: "openai-chatgpt-responses", models: [] },
    } as never);
    expect(authored).toMatchObject({
      id: "gpt-5.4-nano",
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
  });
});
