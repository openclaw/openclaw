import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  buildAtomProvider,
  ATOM_DEFAULT_API_KEY_ENV_VAR,
  ATOM_DEFAULT_BASE_URL,
  ATOM_MODEL_PLACEHOLDER,
  ATOM_PROVIDER_LABEL,
} from "./api.js";

const PROVIDER_ID = "atom";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  id: "atom",
  name: "ATOM Provider",
  description: "Bundled ATOM provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "ATOM",
      docsPath: "/providers/atom",
      envVars: ["ATOM_API_KEY"],
      auth: [
        {
          id: "custom",
          label: ATOM_PROVIDER_LABEL,
          hint: "Self-hosted OpenAI-compatible, optimized for AMD GPUs",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: ATOM_PROVIDER_LABEL,
              defaultBaseUrl: ATOM_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: ATOM_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: ATOM_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: ATOM_PROVIDER_LABEL,
              defaultBaseUrl: ATOM_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: ATOM_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: ATOM_MODEL_PLACEHOLDER,
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
            buildProvider: buildAtomProvider,
          });
        },
      },
      wizard: {
        setup: {
          choiceId: "atom",
          choiceLabel: "ATOM",
          choiceHint: "Self-hosted OpenAI-compatible, optimized for AMD GPUs",
          groupId: "atom",
          groupLabel: "ATOM",
          groupHint: "Self-hosted OpenAI-compatible, optimized for AMD GPUs",
          methodId: "custom",
        },
        modelPicker: {
          label: "ATOM (custom)",
          hint: "Enter ATOM URL + API key + model",
          methodId: "custom",
        },
      },
      resolveReasoningOutputMode: () => "native" as const,
      buildUnknownModelHint: () =>
        "ATOM requires authentication to be registered as a provider. " +
        'Set ATOM_API_KEY (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/atom",
    });
  },
});
