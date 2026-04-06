import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildInferrsProvider,
  INFERRS_DEFAULT_API_KEY_ENV_VAR,
  INFERRS_DEFAULT_BASE_URL,
  INFERRS_MODEL_PLACEHOLDER,
  INFERRS_PROVIDER_LABEL,
} from "./api.js";

const PROVIDER_ID = "inferrs";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  id: "inferrs",
  name: "inferrs Provider",
  description: "Bundled inferrs provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: INFERRS_PROVIDER_LABEL,
      docsPath: "/providers/inferrs",
      envVars: [INFERRS_DEFAULT_API_KEY_ENV_VAR],
      auth: [
        {
          id: "custom",
          label: INFERRS_PROVIDER_LABEL,
          hint: "Local inferrs inference server (OpenAI-compatible)",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: INFERRS_PROVIDER_LABEL,
              defaultBaseUrl: INFERRS_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: INFERRS_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: INFERRS_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: INFERRS_PROVIDER_LABEL,
              defaultBaseUrl: INFERRS_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: INFERRS_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: INFERRS_MODEL_PLACEHOLDER,
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
            buildProvider: buildInferrsProvider,
          });
        },
      },
      wizard: {
        setup: {
          choiceId: "inferrs",
          choiceLabel: "inferrs",
          choiceHint: "Local inferrs inference server (OpenAI-compatible)",
          groupId: "inferrs",
          groupLabel: "inferrs",
          groupHint: "Local/self-hosted OpenAI-compatible",
          methodId: "custom",
        },
        modelPicker: {
          label: "inferrs (custom)",
          hint: "Enter inferrs URL + API key + model (e.g. google/gemma-4-E2B-it)",
          methodId: "custom",
        },
      },
      buildUnknownModelHint: () =>
        "inferrs requires authentication to be registered as a provider. " +
        'Set INFERRS_API_KEY (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/inferrs",
    });
  },
});
