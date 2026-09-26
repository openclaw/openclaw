import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createAnthropicAuthMethods() {
  return {
    cli: {
      id: "cli",
      kind: "custom" as const,
      label: "Claude CLI",
      hint: "Keep using a local Claude CLI login and run Anthropic models through the Claude CLI runtime",
      run: noopAuth,
      wizard: {
        choiceId: "anthropic-cli",
        choiceLabel: "Anthropic Claude CLI",
        choiceHint: "Keep using an existing Claude Code CLI login on this host",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        groupHint: "Claude CLI + API key",
      },
    },
    setupToken: {
      id: "setup-token",
      kind: "token" as const,
      label: "Claude subscription (setup-token)",
      hint: "Run 'claude setup-token' on a computer with Claude Code, then paste the token here",
      run: noopAuth,
      wizard: {
        choiceId: "setup-token",
        choiceLabel: "Claude subscription (setup-token)",
        choiceHint:
          "Run 'claude setup-token' on a computer with Claude Code, then paste the token here",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        groupHint: "Claude CLI + API key + token",
      },
    },
    apiKey: {
      id: "api-key",
      kind: "api_key" as const,
      label: "Anthropic API key",
      hint: "Direct Anthropic API key",
      run: noopAuth,
      wizard: {
        choiceId: "apiKey",
        choiceLabel: "Anthropic API key",
        groupId: "anthropic",
        groupLabel: "Anthropic",
        groupHint: "Claude CLI + API key",
      },
    },
  };
}

export function createAnthropicProvider(): ProviderPlugin {
  return {
    id: "anthropic",
    label: "Anthropic",
    docsPath: "/providers/models",
    hookAliases: ["claude-cli"],
    envVars: ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"],
    auth: Object.values(createAnthropicAuthMethods()),
  };
}
