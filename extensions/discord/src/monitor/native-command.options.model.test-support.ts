// Routed model-policy fixture for Discord native command option tests.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function createDiscordRoutedModelConfig(): OpenClawConfig {
  return {
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
        openai: { models: [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }] },
        anthropic: {
          models: [{ id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}
