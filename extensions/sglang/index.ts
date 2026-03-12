import {
  buildSglangProvider,
  emptyPluginConfigSchema,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/core";

const PROVIDER_ID = "sglang";
const DEFAULT_BASE_URL = "http://127.0.0.1:30000/v1";

const sglangPlugin = {
  id: "sglang",
  name: "SGLang Provider",
  description: "Bundled SGLang provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "SGLang",
      docsPath: "/providers/sglang",
      envVars: ["SGLANG_API_KEY"],
      auth: [
        {
          id: "custom",
          label: "SGLang",
          hint: "Fast self-hosted OpenAI-compatible server",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: "SGLang",
              defaultBaseUrl: DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: "SGLANG_API_KEY",
              modelPlaceholder: "Qwen/Qwen3-8B",
            });
            return {
              profiles: [
                {
                  profileId: result.profileId,
                  credential: result.credential,
                },
              ],
              configPatch: result.config,
              defaultModel: result.modelRef,
            };
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          if (ctx.config.models?.providers?.sglang) {
            return null;
          }
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildSglangProvider({ apiKey: discoveryApiKey })),
              apiKey,
            },
          };
        },
      },
      wizard: {
        onboarding: {
          choiceId: "sglang",
          choiceLabel: "SGLang",
          choiceHint: "Fast self-hosted OpenAI-compatible server",
          groupId: "sglang",
          groupLabel: "SGLang",
          groupHint: "Fast self-hosted server",
          methodId: "custom",
        },
        modelPicker: {
          label: "SGLang (custom)",
          hint: "Enter SGLang URL + API key + model",
          methodId: "custom",
        },
      },
    });
  },
};

export default sglangPlugin;
