import {
  PARALLAX_DEFAULT_API_KEY_ENV_VAR,
  PARALLAX_DEFAULT_BASE_URL,
  PARALLAX_MODEL_PLACEHOLDER,
  PARALLAX_PROVIDER_LABEL,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/core";

const PROVIDER_ID = "parallax";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/self-hosted-provider-setup");
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "Parallax Provider",
  description: "Bundled Parallax provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PARALLAX_PROVIDER_LABEL,
      docsPath: "/providers/parallax",
      envVars: [PARALLAX_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: PARALLAX_PROVIDER_LABEL,
          hint: "Parallax OpenAI-compatible inference endpoint",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: PARALLAX_PROVIDER_LABEL,
              defaultBaseUrl: PARALLAX_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: PARALLAX_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: PARALLAX_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: PARALLAX_PROVIDER_LABEL,
              defaultBaseUrl: PARALLAX_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: PARALLAX_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: PARALLAX_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: providerSetup.buildParallaxProvider,
          });
        },
      },
      wizard: {
        setup: {
          choiceId: "parallax",
          choiceLabel: "Parallax",
          choiceHint: "OpenAI-compatible inference endpoint",
          groupId: "parallax",
          groupLabel: "Parallax",
          groupHint: "Local or proxied Parallax endpoint",
          methodId: "custom",
        },
        modelPicker: {
          label: "Parallax (custom)",
          hint: "Enter Parallax URL + API key + model",
          methodId: "custom",
        },
      },
    });
  },
});
