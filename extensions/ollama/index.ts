import {
  emptyPluginConfigSchema,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
} from "openclaw/plugin-sdk/core";
import { resolveOllamaApiBase } from "../../src/agents/models-config.providers.discovery.js";
import { OLLAMA_DEFAULT_BASE_URL } from "../../src/agents/ollama-defaults.js";

const PROVIDER_ID = "ollama";
const DEFAULT_API_KEY = "ollama-local";

async function loadProviderSetup() {
  return await import("openclaw/plugin-sdk/provider-setup");
}

const ollamaPlugin = {
  id: "ollama",
  name: "Ollama Provider",
  description: "Bundled Ollama provider plugin",
  configSchema: emptyPluginConfigSchema(),
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
              defaultModel: `ollama/${result.defaultModelId}`,
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            const providerSetup = await loadProviderSetup();
            return await providerSetup.configureOllamaNonInteractive({
              nextConfig: ctx.config,
              opts: ctx.opts,
              runtime: ctx.runtime,
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
        await providerSetup.ensureOllamaModelPulled({ config, prompter });
      },
    });
  },
};

export default ollamaPlugin;
