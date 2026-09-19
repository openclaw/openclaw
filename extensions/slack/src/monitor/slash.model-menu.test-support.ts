// Shared routed model-menu fixture for Slack native command tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const model = (id: string, name: string, contextWindow: number) => ({
  id,
  name,
  reasoning: false,
  input: ["text"] as Array<"text">,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens: 8_192,
});

export function createSlackRoutedModelMenuConfig(): OpenClawConfig {
  return {
    commands: { native: true, nativeSkills: false },
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-luna" },
        modelPolicy: { allow: ["openai/gpt-5.6-luna"] },
      },
      entries: {
        research: {
          model: { primary: "anthropic/claude-sonnet-4-6" },
          modelPolicy: { allow: ["anthropic/claude-sonnet-4-6"] },
        },
      },
    },
    models: {
      providers: {
        openai: {
          baseUrl: "https://api.openai.test/v1",
          models: [model("gpt-5.6-luna", "GPT-5.6 Luna", 128_000)],
        },
        anthropic: {
          baseUrl: "https://api.anthropic.test",
          models: [model("claude-sonnet-4-6", "Claude Sonnet 4.6", 200_000)],
        },
      },
    },
  } as OpenClawConfig;
}
