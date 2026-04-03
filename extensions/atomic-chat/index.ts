import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  ATOMIC_CHAT_DEFAULT_BASE_URL,
  buildAtomicChatProvider,
  configureAtomicChatNonInteractive,
  promptAndConfigureAtomicChat,
} from "./api.js";

const PROVIDER_ID = "atomic-chat";
const DEFAULT_API_KEY = "atomic-chat-local";

function shouldSkipAmbientDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

export default definePluginEntry({
  id: "atomic-chat",
  name: "Atomic Chat Provider",
  description: "Bundled Atomic Chat provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Atomic Chat",
      docsPath: "/providers/atomic-chat",
      envVars: ["ATOMIC_CHAT_API_KEY"],
      auth: [
        {
          id: "local",
          label: "Atomic Chat",
          hint: "Local OpenAI-compatible LLM server",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const result = await promptAndConfigureAtomicChat({
              cfg: ctx.config,
              prompter: ctx.prompter,
            });
            return {
              profiles: [
                {
                  profileId: `${PROVIDER_ID}:default`,
                  credential: {
                    type: "api_key",
                    provider: PROVIDER_ID,
                    key: DEFAULT_API_KEY,
                  },
                },
              ],
              configPatch: result.config,
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            return await configureAtomicChatNonInteractive({
              nextConfig: ctx.config,
              opts: {
                customBaseUrl: ctx.opts.customBaseUrl as string | undefined,
                customModelId: ctx.opts.customModelId as string | undefined,
              },
              runtime: ctx.runtime,
              agentDir: ctx.agentDir,
            });
          },
        },
      ],
      discovery: {
        order: "late",
        run: async (ctx: ProviderDiscoveryContext) => {
          const explicit = ctx.config.models?.providers?.[PROVIDER_ID];
          const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
          const apiKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;

          if (hasExplicitModels && explicit) {
            return {
              provider: {
                ...explicit,
                baseUrl:
                  typeof explicit.baseUrl === "string" && explicit.baseUrl.trim()
                    ? explicit.baseUrl.trim().replace(/\/+$/, "")
                    : ATOMIC_CHAT_DEFAULT_BASE_URL,
                api: explicit.api ?? "openai-completions",
                apiKey: apiKey ?? explicit.apiKey ?? DEFAULT_API_KEY,
              },
            };
          }

          if (!apiKey && !explicit && shouldSkipAmbientDiscovery(ctx.env)) {
            return null;
          }

          const provider = await buildAtomicChatProvider({
            baseUrl: explicit?.baseUrl,
            apiKey,
          });
          if (provider.models.length === 0 && !apiKey && !explicit?.apiKey) {
            return null;
          }
          return {
            provider: {
              ...provider,
              apiKey: apiKey ?? explicit?.apiKey ?? DEFAULT_API_KEY,
            },
          };
        },
      },
      wizard: {
        setup: {
          choiceId: "atomic-chat",
          choiceLabel: "Atomic Chat",
          choiceHint: "Local OpenAI-compatible LLM server",
          groupId: "atomic-chat",
          groupLabel: "Atomic Chat",
          groupHint: "Local OpenAI-compatible LLM server",
          methodId: "local",
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
            allowKeepCurrent: false,
          },
        },
        modelPicker: {
          label: "Atomic Chat (custom)",
          hint: "Detect models from a local Atomic Chat instance",
          methodId: "local",
        },
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === DEFAULT_API_KEY,
      resolveSyntheticAuth: ({ providerConfig }) => {
        const hasApiConfig =
          Boolean(providerConfig?.api?.trim()) ||
          Boolean(providerConfig?.baseUrl?.trim()) ||
          (Array.isArray(providerConfig?.models) && providerConfig.models.length > 0);
        if (!hasApiConfig) {
          return undefined;
        }
        return {
          apiKey: DEFAULT_API_KEY,
          source: `models.providers.${PROVIDER_ID} (synthetic local key)`,
          mode: "api-key",
        };
      },
      buildUnknownModelHint: () =>
        "Atomic Chat requires the server to be running for provider registration. " +
        'Start Atomic Chat or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/atomic-chat",
    });
  },
});
