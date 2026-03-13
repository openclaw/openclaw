import {
  buildVllmProvider,
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  emptyPluginConfigSchema,
  promptAndConfigureOpenAICompatibleSelfHostedProvider,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/core";

const PROVIDER_ID = "vllm";
const DEFAULT_BASE_URL = "http://127.0.0.1:8000/v1";

const vllmPlugin = {
  id: "vllm",
  name: "vLLM Provider",
  description: "Bundled vLLM provider plugin",
  configSchema: emptyPluginConfigSchema(),
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "vLLM",
      docsPath: "/providers/vllm",
      envVars: ["VLLM_API_KEY"],
      auth: [
        {
          id: "custom",
          label: "vLLM",
          hint: "Local/self-hosted OpenAI-compatible server",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const result = await promptAndConfigureOpenAICompatibleSelfHostedProvider({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: "vLLM",
              defaultBaseUrl: DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: "VLLM_API_KEY",
              modelPlaceholder: "meta-llama/Meta-Llama-3-8B-Instruct",
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
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
            configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: "vLLM",
              defaultBaseUrl: DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: "VLLM_API_KEY",
              modelPlaceholder: "meta-llama/Meta-Llama-3-8B-Instruct",
            }),
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          if (ctx.config.models?.providers?.vllm) {
            return null;
          }
          const { apiKey, discoveryApiKey } = ctx.resolveProviderApiKey(PROVIDER_ID);
          if (!apiKey) {
            return null;
          }
          return {
            provider: {
              ...(await buildVllmProvider({ apiKey: discoveryApiKey })),
              apiKey,
            },
          };
        },
      },
      wizard: {
        onboarding: {
          choiceId: "vllm",
          choiceLabel: "vLLM",
          choiceHint: "Local/self-hosted OpenAI-compatible server",
          groupId: "vllm",
          groupLabel: "vLLM",
          groupHint: "Local/self-hosted OpenAI-compatible",
          methodId: "custom",
        },
        modelPicker: {
          label: "vLLM (custom)",
          hint: "Enter vLLM URL + API key + model",
          methodId: "custom",
        },
      },
    });
  },
};

export default vllmPlugin;
