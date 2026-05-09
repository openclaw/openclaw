import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolvePluginConfigObject } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthMethodNonInteractiveContext,
  type ProviderAuthResult,
  type ProviderDiscoveryContext,
  type ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { buildApiKeyCredential } from "openclaw/plugin-sdk/provider-auth";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOpenAICompatibleReplayPolicy,
  OPENAI_COMPATIBLE_REPLAY_HOOKS,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildOllamaModelDefinition,
  buildOllamaProvider,
  queryOllamaModelShowInfo,
} from "../ollama/api.js";
import { resolveThinkingProfile as resolveOllamaThinkingProfile } from "../ollama/provider-policy-api.js";
import { readProviderBaseUrl } from "../ollama/runtime-api.js";
import {
  createConfiguredOllamaCompatStreamWrapper,
  createConfiguredOllamaStreamFn,
  isOllamaCompatProvider,
  resolveConfiguredOllamaProviderConfig,
} from "../ollama/runtime-api.js";
import { LEMONADE_DEFAULT_BASE_URL } from "./api.js";
import {
  LEMONADE_DEFAULT_API_KEY,
  LEMONADE_PROVIDER_ID,
  resolveLemonadeDiscoveryResult,
  shouldUseSyntheticLemonadeAuth,
  type LemonadePluginConfig,
} from "./src/discovery-shared.js";
import { configureLemonadeNonInteractive } from "./src/setup.js";
import { promptAndConfigureLemonade } from "./src/interactive-setup.js";

function usesLemonadeOpenAICompatTransport(model: {
  api?: unknown;
  provider?: unknown;
  baseUrl?: unknown;
}): boolean {
  return (
    model.api === "openai-completions" &&
    isOllamaCompatProvider({
      provider: typeof model.provider === "string" ? model.provider : undefined,
      baseUrl: typeof model.baseUrl === "string" ? model.baseUrl : undefined,
      api: "openai-completions",
    })
  );
}

const dynamicModelCache = new Map<string, ProviderRuntimeModel[]>();

function buildDynamicCacheKey(provider: string, baseUrl: string | undefined): string {
  return `${provider}\0${baseUrl ?? ""}`;
}

function hasLemonadeDiscoverySignal(providerConfig: ModelProviderConfig | undefined): boolean {
  return (
    Boolean(process.env.LEMONADE_API_KEY?.trim()) ||
    shouldUseSyntheticLemonadeAuth(providerConfig) ||
    Boolean(providerConfig?.apiKey)
  );
}

function toDynamicLemonadeModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): ProviderRuntimeModel {
  const input = (params.model.input ?? ["text"]).filter(
    (value): value is "text" | "image" => value === "text" || value === "image",
  );
  return {
    id: params.model.id,
    name: params.model.name ?? params.model.id,
    provider: params.provider,
    api: "ollama",
    baseUrl: readProviderBaseUrl(params.providerConfig) ?? "",
    reasoning: params.model.reasoning ?? false,
    input: input.length > 0 ? input : ["text"],
    cost: params.model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: params.model.contextWindow ?? 8192,
    maxTokens: params.model.maxTokens ?? 8192,
    ...(params.model.compat ? { compat: params.model.compat as never } : {}),
    ...(params.model.params ? { params: params.model.params } : {}),
  };
}

async function resolveRequestedDynamicLemonadeModel(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  modelId: string;
}): Promise<ProviderRuntimeModel | undefined> {
  const showInfo = await queryOllamaModelShowInfo(
    readProviderBaseUrl(params.providerConfig) ?? LEMONADE_DEFAULT_BASE_URL,
    params.modelId,
  );
  if (typeof showInfo.contextWindow !== "number" && (showInfo.capabilities?.length ?? 0) === 0) {
    return undefined;
  }
  return toDynamicLemonadeModel({
    provider: params.provider,
    providerConfig: params.providerConfig,
    model: buildOllamaModelDefinition(
      params.modelId,
      showInfo.contextWindow,
      showInfo.capabilities,
    ),
  });
}

export default definePluginEntry({
  id: "lemonade",
  name: "Lemonade Provider",
  description: "Bundled Lemonade provider plugin",
  register(api: OpenClawPluginApi) {
    const startupPluginConfig = (api.pluginConfig ?? {}) as LemonadePluginConfig;
    const resolveCurrentPluginConfig = (config?: OpenClawConfig): LemonadePluginConfig => {
      const runtimePluginConfig = resolvePluginConfigObject(config, "lemonade");
      if (runtimePluginConfig) {
        return runtimePluginConfig as LemonadePluginConfig;
      }
      return config ? {} : startupPluginConfig;
    };
    api.registerProvider({
      id: LEMONADE_PROVIDER_ID,
      label: "Lemonade",
      docsPath: "/providers/lemonade",
      envVars: ["LEMONADE_API_KEY"],
      auth: [
        {
          id: "local",
          label: "Lemonade",
          hint: "Local Lemonade models",
          kind: "custom",
          run: async (ctx: ProviderAuthContext): Promise<ProviderAuthResult> => {
            const result = await promptAndConfigureLemonade({
              cfg: ctx.config,
              prompter: ctx.prompter,
            });
            return {
              profiles: [
                {
                  profileId: "lemonade:default",
                  credential: buildApiKeyCredential(
                    LEMONADE_PROVIDER_ID,
                    result.credential,
                    undefined,
                    undefined,
                  ),
                },
              ],
              configPatch: result.config,
            };
          },
          runNonInteractive: async (ctx: ProviderAuthMethodNonInteractiveContext) => {
            return await configureLemonadeNonInteractive({
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
        run: async (ctx: ProviderDiscoveryContext) =>
          await resolveLemonadeDiscoveryResult({
            ctx,
            pluginConfig: resolveCurrentPluginConfig(ctx.config),
            buildProvider: buildOllamaProvider,
          }),
      },
      wizard: {
        setup: {
          choiceId: "lemonade",
          choiceLabel: "Lemonade",
          choiceHint: "Local Lemonade models",
          groupId: "lemonade",
          groupLabel: "Lemonade",
          groupHint: "Local Lemonade models",
          methodId: "local",
          modelSelection: {
            promptWhenAuthChoiceProvided: true,
            allowKeepCurrent: false,
          },
        },
        modelPicker: {
          label: "Lemonade (custom)",
          hint: "Detect models from a local or remote Lemonade instance",
          methodId: "local",
        },
      },
      createStreamFn: ({ config, model, provider }) => {
        const providerConfig = resolveConfiguredOllamaProviderConfig({ config, providerId: provider });
        return createConfiguredOllamaStreamFn({
          model,
          providerBaseUrl: readProviderBaseUrl(providerConfig) ?? LEMONADE_DEFAULT_BASE_URL,
        });
      },
      ...OPENAI_COMPATIBLE_REPLAY_HOOKS,
      buildReplayPolicy: (ctx) =>
        ctx.modelApi === "ollama"
          ? buildOpenAICompatibleReplayPolicy("openai-completions")
          : buildOpenAICompatibleReplayPolicy(ctx.modelApi),
      contributeResolvedModelCompat: ({ model }) =>
        usesLemonadeOpenAICompatTransport(model) ? { supportsUsageInStreaming: true } : undefined,
      resolveReasoningOutputMode: () => "native",
      resolveThinkingProfile: resolveOllamaThinkingProfile,
      wrapStreamFn: createConfiguredOllamaCompatStreamWrapper,
      matchesContextOverflowError: ({ errorMessage }) =>
        /\b(?:lemonade|ollama)\b.*(?:context length|too many tokens|context window)/i.test(
          errorMessage,
        ) || /\btruncating input\b.*\btoo long\b/i.test(errorMessage),
      resolveSyntheticAuth: ({ provider, providerConfig }) => {
        if (!shouldUseSyntheticLemonadeAuth(providerConfig)) {
          return undefined;
        }
        return {
          apiKey: LEMONADE_DEFAULT_API_KEY,
          source: `models.providers.${provider ?? LEMONADE_PROVIDER_ID} (synthetic local key)`,
          mode: "api-key",
        };
      },
      shouldDeferSyntheticProfileAuth: ({ resolvedApiKey }) =>
        resolvedApiKey?.trim() === LEMONADE_DEFAULT_API_KEY,
      prepareDynamicModel: async (ctx) => {
        const providerConfig = resolveConfiguredOllamaProviderConfig({
          config: ctx.config,
          providerId: ctx.provider,
        });
        if (!hasLemonadeDiscoverySignal(providerConfig)) {
          return;
        }
        const baseUrl = readProviderBaseUrl(providerConfig) ?? LEMONADE_DEFAULT_BASE_URL;
        const provider = await buildOllamaProvider(baseUrl, { quiet: true });
        const dynamicModels = (provider.models ?? []).map((model) =>
          toDynamicLemonadeModel({
            provider: ctx.provider,
            providerConfig: provider,
            model,
          }),
        );
        if (!dynamicModels.some((model) => model.id === ctx.modelId)) {
          const requestedModel = await resolveRequestedDynamicLemonadeModel({
            provider: ctx.provider,
            providerConfig: provider,
            modelId: ctx.modelId,
          });
          if (requestedModel) {
            dynamicModels.push(requestedModel);
          }
        }
        dynamicModelCache.set(buildDynamicCacheKey(ctx.provider, baseUrl), dynamicModels);
      },
      resolveDynamicModel: (ctx) => {
        const providerConfig = resolveConfiguredOllamaProviderConfig({
          config: ctx.config,
          providerId: ctx.provider,
        });
        const baseUrl = readProviderBaseUrl(providerConfig) ?? LEMONADE_DEFAULT_BASE_URL;
        return dynamicModelCache
          .get(buildDynamicCacheKey(ctx.provider, baseUrl))
          ?.find((model) => model.id === ctx.modelId);
      },
      buildUnknownModelHint: () =>
        "Lemonade requires authentication to be registered as a provider. " +
        'Set LEMONADE_API_KEY="lemonade-local" (any value works) or run "openclaw configure". ' +
        "See: https://docs.openclaw.ai/providers/lemonade",
    });
  },
});
