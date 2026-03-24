import {
  LEMONADE_DEFAULT_API_KEY_ENV_VAR,
  LEMONADE_DEFAULT_BASE_URL,
  LEMONADE_MODEL_PLACEHOLDER,
  LEMONADE_PROVIDER_LABEL,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";

const PROVIDER_ID = "lemonade";
const DEFAULT_API_KEY = "lemonade-local";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/self-hosted-provider-setup");
}

export default definePluginEntry({
  id: "lemonade",
  name: "Lemonade Provider",
  description: "Bundled Lemonade Server provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Lemonade",
      docsPath: "/providers/lemonade",
      envVars: ["LEMONADE_API_KEY"],
      auth: [
        {
          id: "custom",
          label: LEMONADE_PROVIDER_LABEL,
          hint: "Local AI server with GPU/NPU acceleration (OpenAI-compatible)",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: LEMONADE_PROVIDER_LABEL,
              defaultBaseUrl: LEMONADE_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: LEMONADE_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: LEMONADE_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: LEMONADE_PROVIDER_LABEL,
              defaultBaseUrl: LEMONADE_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: LEMONADE_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: LEMONADE_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.lemonade;
          const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
          const { apiKey: lemonadeKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);

          if (hasExplicitModels && explicit) {
            return {
              provider: {
                ...explicit,
                baseUrl:
                  typeof explicit.baseUrl === "string" && explicit.baseUrl.trim()
                    ? explicit.baseUrl.trim().replace(/\/+$/, "")
                    : LEMONADE_DEFAULT_BASE_URL,
                api: explicit.api ?? "openai-completions",
                apiKey: lemonadeKey ?? explicit.apiKey ?? DEFAULT_API_KEY,
              },
            };
          }

          const explicitApiKey = normalizeSecretInputString(explicit?.apiKey);
          const providerSetup = await loadProviderSetup();
          const provider = await providerSetup.buildLemonadeProvider({
            baseUrl: explicit?.baseUrl,
            apiKey: discoveryApiKey ?? explicitApiKey,
          });
          if (provider.models.length === 0 && !lemonadeKey && !explicit) {
            return null;
          }
          return {
            provider: {
              ...provider,
              apiKey: lemonadeKey ?? explicitApiKey ?? DEFAULT_API_KEY,
            },
          };
        },
      },
      wizard: {
        setup: {
          choiceId: "lemonade",
          choiceLabel: "Lemonade",
          choiceHint: "Local AI server with GPU/NPU acceleration (OpenAI-compatible)",
          groupId: "lemonade",
          groupLabel: "Lemonade",
          groupHint: "Local AI server with GPU/NPU acceleration",
          methodId: "custom",
        },
        modelPicker: {
          label: "Lemonade (custom)",
          hint: "Enter Lemonade Server URL + API key + model",
          methodId: "custom",
        },
      },
    });
  },
});
