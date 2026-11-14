import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";

const noopAuth = async () => ({ profiles: [] });
const OPENAI_ACCOUNT_WIZARD_GROUP = {
  groupId: "openai",
  groupLabel: "OpenAI",
  groupHint: "Codex login, Sign in with ChatGPT (Beta), or API key",
} as const;
const CODEX_CHATGPT_IMPORT = {
  migrationProviderId: "codex",
  itemId: "auth:openai",
  credentialKind: "oauth",
} as const;
const CODEX_API_KEY_IMPORT = {
  migrationProviderId: "codex",
  itemId: "auth:openai:api-key",
  credentialKind: "api_key",
} as const;

export function createOpenAIProviderMetadata(): ProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    hookAliases: ["azure-openai", "azure-openai-responses"],
    docsPath: "/providers/models",
    envVars: ["OPENAI_API_KEY"],
    auth: (
      [
        {
          id: "oauth",
          kind: "oauth",
          label: "Codex login (browser)",
          hint: "Sign in to Codex locally with your ChatGPT account",
          credentialImport: CODEX_CHATGPT_IMPORT,
          wizard: {
            choiceId: "openai",
            assistantPriority: -10,
          },
        },
        {
          id: "device-code",
          kind: "device_code",
          label: "Codex login (device code)",
          hint: "Use a browser code when OpenClaw runs on a remote VM",
          credentialImport: CODEX_CHATGPT_IMPORT,
          wizard: {
            choiceId: "openai-device-code",
            assistantPriority: -40,
            onboardingFeatured: true,
          },
        },
        {
          id: "siwc",
          kind: "oauth",
          label: "Sign in with ChatGPT (Beta)",
          hint: "Authorize OpenClaw for eligible Responses models using your Codex allowance",
          wizard: {
            choiceId: "openai-token-sharing",
            assistantPriority: 0,
          },
        },
        {
          id: "api-key",
          kind: "api_key",
          label: "OpenAI API Key",
          hint: "Use your OpenAI API key directly",
          credentialImport: CODEX_API_KEY_IMPORT,
          wizard: {
            choiceId: "openai-api-key",
            assistantPriority: 5,
            onboardingFeatured: true,
          },
        },
      ] satisfies Omit<ProviderPlugin["auth"][number], "run">[]
    ).map((method) =>
      Object.assign({}, method, {
        run: noopAuth,
        wizard: {
          ...method.wizard,
          choiceLabel: method.label,
          choiceHint: method.hint,
          ...OPENAI_ACCOUNT_WIZARD_GROUP,
        },
      }),
    ),
  };
}
