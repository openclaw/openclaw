import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/plugin-entry";
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

const PROVIDER_ID = "ollama";
const DEFAULT_API_KEY = "ollama-local";

function shouldSkipAmbientOllamaDiscovery(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === "test";
}

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

export default definePluginEntry({
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  register(api: OpenClawPluginApi) {
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
            const providerSetup = await loadProviderSetup();
            const result = await providerSetup.promptAndConfigureOllama({
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
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOllamaNonInteractive({
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

          const providerSetup = await loadProviderSetup();
          const provider = await providerSetup.buildOllamaProvider(explicit?.baseUrl, {
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
        const providerSetup = await loadProviderSetup();
        await providerSetup.ensureOllamaModelPulled({ config, model, prompter });
      },
      createStreamFn: ({ config, model }) => {
        return createConfiguredOllamaStreamFn({
          model,
          providerBaseUrl: config?.models?.providers?.ollama?.baseUrl,
        });
      },
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
      buildUnknownModelHint: () =>
        "Ollama requires authentication to be registered as a provider. " +
        'Set OLLAMA_API_KEY="ollama-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/ollama",
    });
  },
});
