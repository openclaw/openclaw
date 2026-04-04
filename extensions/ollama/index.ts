import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildOpenAICompatibleReplayPolicy } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOllamaProvider,
  configureOllamaNonInteractive,
  ensureOllamaModelPulled,
  promptAndConfigureOllama,
} from "./api.js";
import { OLLAMA_DEFAULT_BASE_URL } from "./src/defaults.js";
import {
  DEFAULT_OLLAMA_EMBEDDING_MODEL,
  createOllamaEmbeddingProvider,
} from "./src/embedding-provider.js";
import { resolveOllamaApiBase } from "./src/provider-models.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
} from "./src/stream.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";

const PROVIDER_ID = "ollama";
const DEFAULT_API_KEY = "ollama-local";

function shouldSkipAmbientOllamaDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

export default definePluginEntry({
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  register(api: OpenClawPluginApi) {
    api.registerWebSearchProvider(createOllamaWebSearchProvider());
    api.registerProvider({
      id: PROVIDER_ID,
      label: "Ollama",
      docsPath: "/providers/ollama",
      envVars: ["OLLAMA_API_KEY"],
      auth: [
        {
          id: "local",
          label: "Ollama",
          hint: "Cloud and local open models",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const result = await promptAndConfigureOllama({
              cfg: ctx.config,
              prompter: ctx.prompter,
              isRemote: ctx.isRemote,
              openUrl: ctx.openUrl,
            });
            return {
              profiles: [
                {
                  profileId: "ollama:default",
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
            return await configureOllamaNonInteractive({
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
          const explicit = ctx.config.models?.providers?.ollama;
          const hasExplicitModels = Array.isArray(explicit?.models) && explicit.models.length > 0;
          const ollamaKey = ctx.resolveProviderApiKey(PROVIDER_ID).apiKey;
          if (hasExplicitModels && explicit) {
            return {
              provider: {
                ...explicit,
                baseUrl:
                  typeof explicit.baseUrl === "string" && explicit.baseUrl.trim()
                    ? resolveOllamaApiBase(explicit.baseUrl)
                    : OLLAMA_DEFAULT_BASE_URL,
                api: explicit.api ?? "ollama",
                apiKey: ollamaKey ?? explicit.apiKey ?? DEFAULT_API_KEY,
              },
            };
          }
          if (!ollamaKey && !explicit && shouldSkipAmbientOllamaDiscovery(ctx.env)) {
            return null;
          }

          const provider = await buildOllamaProvider(explicit?.baseUrl, {
            quiet: !ollamaKey && !explicit,
          });
          if (provider.models.length === 0 && !ollamaKey && !explicit?.apiKey) {
            return null;
          }
          return {
            provider: {
              ...provider,
              apiKey: ollamaKey ?? explicit?.apiKey ?? DEFAULT_API_KEY,
            },
          };
        },
      },
      wizard: {
        setup: {
          choiceId: "ollama",
          choiceLabel: "Ollama",
          choiceHint: "Cloud and local open models",
          groupId: "ollama",
          groupLabel: "Ollama",
          groupHint: "Cloud and local open models",
          methodId: "local",
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
            allowKeepCurrent: false,
          },
        },
        modelPicker: {
          label: "Ollama (custom)",
          hint: "Detect models from a local or remote Ollama instance",
          methodId: "local",
        },
      },
      onModelSelected: async ({ config, model, prompter }) => {
        if (!model.startsWith("ollama/")) {
          return;
        }
        await ensureOllamaModelPulled({ config, model, prompter });
      },
      createStreamFn: ({ config, model }) => {
        return createConfiguredOllamaStreamFn({
          model,
          providerBaseUrl: config?.models?.providers?.ollama?.baseUrl,
        });
      },
      buildReplayPolicy: (ctx) => buildOpenAICompatibleReplayPolicy(ctx.modelApi),
      wrapStreamFn: (ctx) => {
        return createConfiguredOllamaCompatStreamWrapper(ctx);
      },
      createEmbeddingProvider: async ({ config, model, remote }) => {
        const { provider, client } = await createOllamaEmbeddingProvider({
          config,
          remote,
          model: model || DEFAULT_OLLAMA_EMBEDDING_MODEL,
        });
        return {
          ...provider,
          client,
        };
      },
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
          source: "models.providers.ollama (synthetic local key)",
          mode: "api-key",
        };
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === DEFAULT_API_KEY,
      buildUnknownModelHint: () =>
        "Ollama requires authentication to be registered as a provider. " +
        'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
  },
});
