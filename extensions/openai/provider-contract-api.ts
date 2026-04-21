import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });

export function createOpenAICodexProvider(): ProviderPlugin {
  return {
    id: "openai-codex",
    label: "OpenAI Codex",
    docsPath: "/providers/models",
    auth: [
      {
        id: "oauth",
        kind: "oauth",
        label: "ChatGPT OAuth",
        hint: "Browser sign-in",
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex",
          choiceLabel: "OpenAI Codex (ChatGPT OAuth)",
          choiceHint: "Browser sign-in",
          groupId: "openai",
          groupLabel: "OpenAI",
          groupHint: "Codex OAuth + API key",
        },
      },
      {
        id: "device-code",
        kind: "device_code",
        label: "ChatGPT device code",
        hint: "Browser device-code sign-in",
        run: noopAuth,
        wizard: {
          choiceId: "openai-codex-device-code",
          choiceLabel: "OpenAI Codex (device code)",
          choiceHint: "Browser device-code sign-in",
          groupId: "openai",
          groupLabel: "OpenAI",
          groupHint: "Codex OAuth + API key",
        },
      },
    ],
  };
}

export function createOpenAIProvider(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: [
      {
        id: "api-key",
        kind: "api_key",
        label: "OpenAI API key",
        hint: "Direct OpenAI API key",
        run: noopAuth,
        wizard: {
          choiceId: "openai-api-key",
          choiceLabel: "OpenAI API key",
          groupId: "openai",
          groupLabel: "OpenAI",
          groupHint: "Codex OAuth + API key",
        },
      },
    ],
  };
}
