import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createAnthropicProvider(): ProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic",
    docsPath: "/providers/models",
    hookAliases: ["claude-cli"],
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    auth: [
      {
        id: "cli",
        kind: "custom",
        label: "Claude subscription (no API key)",
        hint: "Use your Claude Pro/Max subscription via the Claude CLI in headless mode",
        run: noopAuth,
        wizard: {
          choiceId: "anthropic-cli",
          choiceLabel: "Claude subscription (no API key needed)",
          choiceHint: "Runs Claude through the Claude CLI in headless mode using your Pro/Max plan",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude subscription + API key",
        },
      },
      {
        id: "setup-token",
        kind: "token",
        label: "Anthropic setup-token",
        hint: "Manual bearer token path",
        run: noopAuth,
        wizard: {
          choiceId: "setup-token",
          choiceLabel: "Anthropic setup-token",
          choiceHint: "Manual token path",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude subscription + API key + token",
        },
      },
      {
        id: "api-key",
        kind: "api_key",
        label: "Anthropic API key",
        hint: "Direct Anthropic API key",
        run: noopAuth,
        wizard: {
          choiceId: "apiKey",
          choiceLabel: "Anthropic API key",
          groupId: "anthropic",
          groupLabel: "Anthropic",
          groupHint: "Claude subscription + API key",
        },
      },
    ],
  };
}
