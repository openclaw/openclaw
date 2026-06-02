import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthMethodNonInteractiveContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import {
  ATOMICCHAT_DEFAULT_API_KEY_ENV_VAR,
  ATOMICCHAT_DEFAULT_BASE_URL,
  ATOMICCHAT_MODEL_PLACEHOLDER,
  ATOMICCHAT_PROVIDER_LABEL,
  buildAtomicChatProvider,
} from "./api.js";

const PROVIDER_ID = "atomicchat";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  id: "atomicchat",
  name: "Atomic Chat Provider",
  description: "Bundled Atomic Chat provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Atomic Chat",
      docsPath: "/providers/atomicchat",
      envVars: ["ATOMIC_CHAT_API_KEY"],
      auth: [
        {
          id: "custom",
          label: ATOMICCHAT_PROVIDER_LABEL,
          hint: "Local Atomic Chat OpenAI-compatible server",
          kind: "custom",
          run: async (ctx) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.promptAndConfigureOpenAICompatibleSelfHostedProviderAuth({
              cfg: ctx.config,
              prompter: ctx.prompter,
              providerId: PROVIDER_ID,
              providerLabel: ATOMICCHAT_PROVIDER_LABEL,
              defaultBaseUrl: ATOMICCHAT_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: ATOMICCHAT_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: ATOMICCHAT_MODEL_PLACEHOLDER,
            });
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOpenAICompatibleSelfHostedProviderNonInteractive({
              ctx,
              providerId: PROVIDER_ID,
              providerLabel: ATOMICCHAT_PROVIDER_LABEL,
              defaultBaseUrl: ATOMICCHAT_DEFAULT_BASE_URL,
              defaultApiKeyEnvVar: ATOMICCHAT_DEFAULT_API_KEY_ENV_VAR,
              modelPlaceholder: ATOMICCHAT_MODEL_PLACEHOLDER,
            });
          },
        },
      ],
      catalog: {
        order: "late",
        run: async (ctx) => {
          const providerSetup = await loadProviderSetup();
          return await providerSetup.discoverOpenAICompatibleSelfHostedProvider({
            ctx,
            providerId: PROVIDER_ID,
            buildProvider: buildAtomicChatProvider,
          });
        },
      },
      ...buildProviderReplayFamilyHooks({
        family: "openai-compatible",
        dropReasoningFromHistory: false,
      }),
      wizard: {
        setup: {
          choiceId: "atomicchat",
          choiceLabel: "Atomic Chat",
          choiceHint: "Local Atomic Chat OpenAI-compatible server",
          groupId: "atomicchat",
          groupLabel: "Atomic Chat",
          groupHint: "Local AI provider",
          methodId: "custom",
        },
        modelPicker: {
          label: "Atomic Chat (custom)",
          hint: "Enter Atomic Chat URL + API key + model",
          methodId: "custom",
        },
      },
    });
  },
});
