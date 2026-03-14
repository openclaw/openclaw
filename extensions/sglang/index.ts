import {
  buildSglangProvider,
  configureOpenAICompatibleSelfHostedProviderNonInteractive,
  discoverOpenAICompatibleSelfHostedProvider,
  emptyPluginConfigSchema,
  promptAndConfigureOpenAICompatibleSelfHostedProviderAuth,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
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
          run: async (ctx) =>
            promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: "SGLang",
              defaultBaseUrl: DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: "SGLANG_API_KEY",
              modelPlaceholder: "Qwen/Qwen3-8B",
            }),
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) =>
            configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: "SGLang",
              defaultBaseUrl: DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: "SGLANG_API_KEY",
              modelPlaceholder: "Qwen/Qwen3-8B",
            }),
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx) =>
          discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildSglangProvider,
          }),
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
