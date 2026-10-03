import type { OpenClawConfig } from "../config/config.js";

export const copilotModelId = "gpt-4o";

export const makeCopilotConfig = (): OpenClawConfig =>
  ({
    agents: {
      list: [{ id: "test" }],
    },
    models: {
      providers: {
        "github-copilot": {
          api: "openai-responses",
          baseUrl: "https://api.copilot.example",
          models: [
            {
              id: copilotModelId,
              name: "Copilot GPT-4o",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 16_000,
              maxTokens: 2048,
            },
          ],
        },
      },
    },
  }) satisfies OpenClawConfig;
