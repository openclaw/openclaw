import { describe, expect, it } from "vitest";
import type { ProviderPlugin } from "../../src/plugins/types.js";
import githubCopilotPlugin from "./index.js";

function registerProvider(): ProviderPlugin {
  let provider: ProviderPlugin | undefined;
  githubCopilotPlugin.register({
    registerProvider(nextProvider: ProviderPlugin) {
      provider = nextProvider;
    },
  } as never);
  if (!provider) {
    throw new Error("provider registration missing");
  }
  return provider;
}

describe("github-copilot plugin", () => {
  it("owns Copilot-specific forward-compat fallbacks", () => {
    const provider = registerProvider();
    const model = provider.resolveDynamicModel?.({
      provider: "github-copilot",
      modelId: "gpt-5.3-codex",
      modelRegistry: {
        find: (_provider: string, id: string) =>
          id === "gpt-5.2-codex"
            ? {
                id,
                name: id,
                api: "openai-codex-responses",
                provider: "github-copilot",
                baseUrl: "https://api.copilot.example",
                reasoning: true,
                input: ["text"],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128_000,
                maxTokens: 8_192,
              }
            : null,
      } as never,
    });

    expect(model).toMatchObject({
      id: "gpt-5.3-codex",
      provider: "github-copilot",
      api: "openai-codex-responses",
    });
  });
});
