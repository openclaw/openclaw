import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth-markers";
import type { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import {
  DEFAULT_CONTEXT_TOKENS,
  findCatalogTemplate,
  matchesExactOrPrefix,
  normalizeProviderId,
} from "openclaw/plugin-sdk/provider-model-metadata";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
  ProviderPlugin,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { OPENAI_UNKNOWN_MODEL_COST } from "./account-models.js";
import {
  OPENAI_CODEX_RESPONSES_BASE_URL,
  resolveOpenAICodexModelsEndpoint,
  type OpenAICodexModelsEndpointContext,
  resolveOpenAIDefaultBaseUrl,
} from "./base-url.js";
import {
  normalizeOpenAICodexCatalogModel,
  readCodexReasoningLevels,
  readCodexModelRows,
  shouldIncludeCodexModelRow,
  resolveCodexModelInput,
  type OpenAILiveModelReaders,
} from "./codex-model-rows.js";
import {
  buildOpenAILiveProviderConfig,
  buildOpenAIStaticPlatformProviderConfig,
  OPENAI_MANIFEST_PROVIDER,
  OPENAI_GPT_54_MAX_TOKENS,
} from "./model-catalog-config.js";
import {
  OPENAI_DAYBREAK_MODEL_IDS,
  OPENAI_GPT_54_MINI_MODEL_ID,
  OPENAI_GPT_54_MODEL_ID,
  OPENAI_GPT_54_NANO_MODEL_ID,
  OPENAI_GPT_54_PRO_MODEL_ID,
  OPENAI_GPT_55_MODEL_ID,
  OPENAI_GPT_55_PRO_MODEL_ID,
  OPENAI_GPT_56_MODEL_ID,
  OPENAI_GPT_56_SOL_MODEL_ID,
  OPENAI_GPT_6_MODEL_IDS,
  OPENAI_GPT_61_SOL_MODEL_ID,
  isOpenAIPlatformOnlyRouteModelId,
  OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
  OPENAI_CODEX_GPT_61_SOL_CONTEXT_TOKENS,
} from "./model-route-contract.js";
import {
  buildOpenAICodexReadyOutcome,
  type OpenAILiveProviderCatalog,
  projectOpenAICatalog,
} from "./model-service-tiers.js";
import { isSIWCAuthFlow, TOKEN_SHARING_RESOURCE } from "./token-sharing.js";

const PROVIDER_ID = "openai";

const OPENAI_CODEX_MODELS_CACHE_TTL_MS = 60_000;
export const OPENAI_CATALOG_AUGMENTATIONS = [
  {
    id: OPENAI_GPT_55_PRO_MODEL_ID,
    templateIds: [OPENAI_GPT_54_PRO_MODEL_ID, OPENAI_GPT_54_MODEL_ID],
    contextWindow: 1_050_000,
    contextTokens: OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
  },
  // Repair an already-authorized model before borrowing an older family template;
  // remote discovery must not be needed to restore its native image capability.
  {
    id: OPENAI_GPT_54_MODEL_ID,
    templateIds: [OPENAI_GPT_54_MODEL_ID, OPENAI_GPT_55_MODEL_ID],
    contextWindow: 1_050_000,
  },
  {
    id: OPENAI_GPT_54_PRO_MODEL_ID,
    templateIds: [OPENAI_GPT_54_PRO_MODEL_ID, OPENAI_GPT_55_PRO_MODEL_ID],
    contextWindow: 1_050_000,
  },
  {
    id: OPENAI_GPT_54_MINI_MODEL_ID,
    templateIds: [OPENAI_GPT_54_MINI_MODEL_ID, "gpt-5-mini"],
    contextWindow: 400_000,
  },
  {
    id: OPENAI_GPT_54_NANO_MODEL_ID,
    templateIds: [OPENAI_GPT_54_NANO_MODEL_ID, "gpt-5-nano", "gpt-5-mini"],
    contextWindow: 400_000,
  },
];

function resolveCodexModelFallback(modelId: string): ModelDefinitionConfig | undefined {
  const fallbackModel = OPENAI_MANIFEST_PROVIDER.models.find(
    (candidate) =>
      normalizeLowercaseStringOrEmpty(candidate.id) === normalizeLowercaseStringOrEmpty(modelId),
  );
  if (fallbackModel?.id === OPENAI_GPT_61_SOL_MODEL_ID) {
    return { ...fallbackModel, contextTokens: OPENAI_CODEX_GPT_61_SOL_CONTEXT_TOKENS };
  }
  return fallbackModel ? normalizeOpenAICodexCatalogModel(fallbackModel) : undefined;
}

function buildOpenAICodexModelFromLiveRow(
  row: unknown,
  readers: OpenAILiveModelReaders,
): ModelDefinitionConfig | undefined {
  const { readLiveModelCatalogStringField, readLiveModelCatalogPositiveSafeIntegerField } = readers;
  if (!shouldIncludeCodexModelRow(row, readers)) {
    return undefined;
  }
  const modelId =
    readLiveModelCatalogStringField(row, "slug") ?? readLiveModelCatalogStringField(row, "id");
  if (!modelId) {
    return undefined;
  }
  if (isOpenAIPlatformOnlyRouteModelId(modelId)) {
    return undefined;
  }
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const fallback = resolveCodexModelFallback(modelId);
  const reasoningLevels = readCodexReasoningLevels(row);
  const observedContextTokens = readLiveModelCatalogPositiveSafeIntegerField(row, [
    "context_window",
    "contextWindow",
  ]);
  const isGpt56Model = matchesExactOrPrefix(normalizedModelId, [OPENAI_GPT_56_MODEL_ID]);
  const contextTokens = isGpt56Model
    ? Math.min(
        observedContextTokens ?? fallback?.contextTokens ?? OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
        OPENAI_DEFAULT_RUNTIME_CONTEXT_TOKENS,
      )
    : observedContextTokens;
  const contextWindow =
    readLiveModelCatalogPositiveSafeIntegerField(row, ["max_context_window", "maxContextWindow"]) ??
    fallback?.contextWindow ??
    observedContextTokens ??
    DEFAULT_CONTEXT_TOKENS;
  const maxTokens =
    readLiveModelCatalogPositiveSafeIntegerField(row, [
      "max_output_tokens",
      "maxOutputTokens",
      "max_completion_tokens",
      "maxCompletionTokens",
    ]) ??
    fallback?.maxTokens ??
    OPENAI_GPT_54_MAX_TOKENS;
  const compat =
    reasoningLevels !== undefined
      ? {
          ...fallback?.compat,
          supportsReasoningEffort: true,
          supportedReasoningEfforts: [...reasoningLevels],
        }
      : fallback?.compat;
  const thinkingLevelMap = {
    ...(reasoningLevels === undefined ? fallback?.thinkingLevelMap : {}),
    ...(fallback?.thinkingLevelMap?.off === null || normalizedModelId.startsWith("gpt-5.6")
      ? { off: null }
      : {}),
    ...(reasoningLevels?.includes("xhigh") ? { xhigh: "xhigh" as const } : {}),
    ...(reasoningLevels?.includes("max") ? { max: "max" as const } : {}),
  };

  return normalizeOpenAICodexCatalogModel({
    id: modelId,
    name: readLiveModelCatalogStringField(row, "display_name") ?? fallback?.name ?? modelId,
    api: "openai-chatgpt-responses",
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    reasoning: (reasoningLevels?.length ?? 0) > 0 || fallback?.reasoning || false,
    input: resolveCodexModelInput(row, fallback),
    cost: fallback?.cost ?? OPENAI_UNKNOWN_MODEL_COST,
    contextWindow,
    maxTokens,
    ...((contextTokens ?? fallback?.contextTokens)
      ? { contextTokens: contextTokens ?? fallback?.contextTokens }
      : {}),
    ...(fallback?.mediaInput ? { mediaInput: fallback.mediaInput } : {}),
    ...(compat ? { compat } : {}),
    ...(Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
  });
}

function buildOpenAICodexStaticProviderConfig(): ModelProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
    api: "openai-chatgpt-responses",
    auth: "oauth",
    models: OPENAI_MANIFEST_PROVIDER.models.flatMap((model) => {
      const modelId = normalizeLowercaseStringOrEmpty(model.id);
      if (isOpenAIPlatformOnlyRouteModelId(modelId)) {
        return [];
      }
      // New model availability comes from successful account discovery.
      if (
        OPENAI_GPT_6_MODEL_IDS.some((id) => id === modelId) ||
        OPENAI_DAYBREAK_MODEL_IDS.some((id) => id === modelId) ||
        (modelId.startsWith("gpt-5.6") && modelId !== OPENAI_GPT_56_SOL_MODEL_ID)
      ) {
        return [];
      }
      return [normalizeOpenAICodexCatalogModel(model)];
    }),
  };
}

async function buildOpenAICodexLiveProviderConfig(params: {
  discoveryApiKey: string;
  accountId?: string;
  catalogContext?: OpenAICodexModelsEndpointContext;
}): Promise<OpenAILiveProviderCatalog> {
  const catalogRuntime = await import("openclaw/plugin-sdk/provider-catalog-live-runtime");
  const { getCachedLiveCatalogValue } = await import("openclaw/plugin-sdk/provider-catalog-shared");
  const { fetchLiveProviderModelRows, LiveModelCatalogHttpError } = catalogRuntime;
  const endpoint = await resolveOpenAICodexModelsEndpoint(params.catalogContext);
  try {
    return await getCachedLiveCatalogValue({
      ttlMs: OPENAI_CODEX_MODELS_CACHE_TTL_MS,
      keyParts: [
        PROVIDER_ID,
        "codex-catalog",
        endpoint,
        params.discoveryApiKey,
        params.accountId ?? "",
      ],
      load: async (signal): Promise<OpenAILiveProviderCatalog> => {
        const rows = await fetchLiveProviderModelRows({
          providerId: PROVIDER_ID,
          endpoint,
          discoveryApiKey: params.discoveryApiKey,
          signal,
          auditContext: "openai-model-discovery",
          readRows: readCodexModelRows,
          buildRequestHeaders: ({ discoveryApiKey }) => ({
            Accept: "application/json",
            ...(discoveryApiKey ? { Authorization: `Bearer ${discoveryApiKey}` } : {}),
            ...(params.accountId ? { "ChatGPT-Account-ID": params.accountId } : {}),
          }),
        });
        // The backend also sends prompt templates; retain only account catalog facts.
        return {
          provider: {
            baseUrl: OPENAI_CODEX_RESPONSES_BASE_URL,
            api: "openai-chatgpt-responses",
            auth: "oauth",
            models: rows
              .map((row) => buildOpenAICodexModelFromLiveRow(row, catalogRuntime))
              .filter((model): model is ModelDefinitionConfig => Boolean(model)),
          },
          outcome: buildOpenAICodexReadyOutcome(rows),
        };
      },
    });
  } catch (error) {
    if (
      error instanceof LiveModelCatalogHttpError &&
      (error.status === 401 || error.status === 403)
    ) {
      return {
        provider: { ...buildOpenAICodexStaticProviderConfig(), models: [] },
        outcome: { provider: PROVIDER_ID, status: "auth-rejected" },
      };
    }
    // Codex/ChatGPT discovery is advisory. Static OpenAI rows stay available
    // when OAuth refresh or the remote model list is unavailable.
  }
  return {
    provider: buildOpenAICodexStaticProviderConfig(),
    outcome: { provider: PROVIDER_ID, status: "unavailable" },
  };
}

export function isCodexCatalogAuthMode(mode: string): boolean {
  return mode === "oauth" || mode === "token";
}

function resolveOpenAICatalogBaseUrl(ctx: {
  config?: { models?: { providers?: Record<string, { baseUrl?: string } | undefined> } };
  env?: Record<string, string | undefined>;
}): string {
  const configuredProvider = Object.entries(ctx.config?.models?.providers ?? {}).find(
    ([providerId]) => normalizeProviderId(providerId) === PROVIDER_ID,
  )?.[1];
  return (
    normalizeOptionalString(configuredProvider?.baseUrl) ??
    resolveOpenAIDefaultBaseUrl(ctx.env ?? process.env)
  );
}

export function buildOpenAIProviderCatalog(): Pick<
  ProviderPlugin,
  "catalog" | "staticCatalog" | "augmentModelCatalog"
> {
  return {
    catalog: {
      order: "simple",
      run: async (ctx) => {
        if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID)) {
          return null;
        }
        const auth = ctx.resolveProviderAuth(PROVIDER_ID);
        if (isSIWCAuthFlow(auth.authFlow)) {
          const { buildTokenSharingCatalog } = await import("./token-sharing-catalog.js");
          return await buildTokenSharingCatalog({
            auth,
            models: buildOpenAIStaticPlatformProviderConfig(undefined, TOKEN_SHARING_RESOURCE)
              .models,
            signal: ctx.signal,
          });
        }
        if (auth.preparationFailed) {
          return null;
        }
        let runtimeAuth: Awaited<ReturnType<typeof resolveApiKeyForProvider>> | undefined;
        if (auth.profileId || auth.mode === "none") {
          const { resolveApiKeyForProvider } =
            await import("openclaw/plugin-sdk/provider-auth-runtime");
          try {
            runtimeAuth = await resolveApiKeyForProvider({
              provider: PROVIDER_ID,
              cfg: ctx.config,
              ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
              ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
              ...(auth.profileId
                ? {
                    profileId: auth.profileId,
                    lockedProfile: true,
                  }
                : {}),
            });
          } catch {
            runtimeAuth = undefined;
          }
        }
        if (runtimeAuth && isCodexCatalogAuthMode(runtimeAuth.mode) && runtimeAuth.apiKey) {
          const { resolveProviderAuthProfileMetadataAsync } =
            await import("openclaw/plugin-sdk/provider-auth-runtime");
          const metadata = await resolveProviderAuthProfileMetadataAsync({
            provider: PROVIDER_ID,
            cfg: ctx.config,
            ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
            ...((runtimeAuth.profileId ?? auth.profileId)
              ? { profileId: runtimeAuth.profileId ?? auth.profileId }
              : {}),
          });
          return projectOpenAICatalog(
            await buildOpenAICodexLiveProviderConfig({
              discoveryApiKey: runtimeAuth.apiKey,
              accountId: metadata.accountId,
              catalogContext: ctx,
            }),
            runtimeAuth.profileId ?? auth.profileId,
          );
        }
        if (!auth.profileId && isCodexCatalogAuthMode(auth.mode) && auth.apiKey) {
          const discoveryApiKey =
            auth.discoveryApiKey ??
            (isNonSecretApiKeyMarker(auth.apiKey) ? undefined : auth.apiKey);
          if (!discoveryApiKey) {
            return {
              providers: { [PROVIDER_ID]: buildOpenAICodexStaticProviderConfig() },
              outcomes: [{ provider: PROVIDER_ID, status: "unavailable" }],
            };
          }
          return projectOpenAICatalog(
            await buildOpenAICodexLiveProviderConfig({ discoveryApiKey, catalogContext: ctx }),
          );
        }
        if (auth.profileId && isCodexCatalogAuthMode(auth.mode)) {
          return {
            providers: { [PROVIDER_ID]: buildOpenAICodexStaticProviderConfig() },
            outcomes: [
              {
                provider: PROVIDER_ID,
                profileId: auth.profileId,
                status: "unavailable",
              },
            ],
          };
        }
        if (auth.mode === "api_key" && auth.apiKey) {
          const discoveryApiKey =
            auth.discoveryApiKey ??
            (runtimeAuth?.mode === "api-key" ? runtimeAuth.apiKey : undefined);
          if (!discoveryApiKey && isNonSecretApiKeyMarker(auth.apiKey)) {
            return {
              providers: {
                [PROVIDER_ID]: buildOpenAIStaticPlatformProviderConfig(
                  auth.apiKey,
                  resolveOpenAICatalogBaseUrl(ctx),
                ),
              },
              outcomes: [
                {
                  provider: PROVIDER_ID,
                  ...(auth.profileId ? { profileId: auth.profileId } : {}),
                  rejectionScope: "catalog",
                  status: "unavailable",
                },
              ],
            };
          }
          return projectOpenAICatalog(
            await buildOpenAILiveProviderConfig({
              apiKey: auth.apiKey,
              baseUrl: resolveOpenAICatalogBaseUrl(ctx),
              discoveryApiKey,
              catalogContext: ctx,
            }),
            auth.profileId,
          );
        }
        return null;
      },
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ providers: { [PROVIDER_ID]: OPENAI_MANIFEST_PROVIDER } }),
    },
    augmentModelCatalog: (ctx) => {
      return OPENAI_CATALOG_AUGMENTATIONS.flatMap(({ templateIds, ...model }) => {
        const template = findCatalogTemplate({
          entries: ctx.entries,
          providerId: PROVIDER_ID,
          templateIds,
        });
        const input: ("text" | "image")[] = ["text", "image"];
        return template ? [{ ...template, ...model, name: model.id, reasoning: true, input }] : [];
      });
    },
  };
}
