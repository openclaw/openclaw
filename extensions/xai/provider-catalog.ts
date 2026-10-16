import {
  buildLiveModelProviderConfig,
  readLiveModelCatalogBooleanField,
  readLiveModelCatalogPositiveSafeIntegerField,
  readLiveModelCatalogStringField,
  type LiveModelCatalogFetchGuard,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildXaiCatalogModels,
  resolveXaiCatalogEntry,
  XAI_BASE_URL,
  XAI_DEFAULT_CONTEXT_WINDOW,
  XAI_IMAGE_MODELS,
  XAI_DEFAULT_MAX_TOKENS,
  XAI_UNKNOWN_MODEL_COST,
} from "./model-definitions.js";
import { normalizeXaiReasoningEfforts } from "./model-id.js";

const PROVIDER_ID = "xai";
const XAI_MODELS_ENDPOINT = `${XAI_BASE_URL}/models`;
const XAI_GROK_OAUTH_BASE_URL = "https://cli-chat-proxy.grok.com/v1";
const XAI_GROK_OAUTH_MODELS_ENDPOINT = `${XAI_GROK_OAUTH_BASE_URL}/models`;
const XAI_MODELS_CACHE_TTL_MS = 60_000;
const XAI_GROK_OAUTH_MODELS_CACHE_TTL_MS = 60_000;
// Composer emits replayable Responses reasoning, but the OAuth catalog omits that capability.
// Keep it classified here or the stream wrapper will omit encrypted reasoning from replay.
const XAI_GROK_OAUTH_REASONING_MODEL_IDS = new Set(["grok-composer-2.5-fast"]);

export function isXaiGrokProxyBaseUrl(baseUrl: string | undefined): boolean {
  return URL.parse(baseUrl ?? "")?.href.replace(/\/+$/u, "") === XAI_GROK_OAUTH_BASE_URL;
}

export function buildXaiProvider(
  api: ModelProviderConfig["api"] = "openai-responses",
  authMode?: "oauth" | "token",
): ModelProviderConfig {
  return {
    baseUrl: authMode ? XAI_GROK_OAUTH_BASE_URL : XAI_BASE_URL,
    api: authMode ? "openai-responses" : api,
    ...(authMode ? { auth: authMode } : {}),
    models: buildXaiCatalogModels(),
  };
}

export async function buildLiveXaiProvider(params: {
  apiKey?: string;
  discoveryApiKey?: string;
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const provider = await buildLiveModelProviderConfig({
    discoveryMode: "strict",
    providerId: PROVIDER_ID,
    endpoint: XAI_MODELS_ENDPOINT,
    providerConfig: {
      baseUrl: XAI_BASE_URL,
      api: "openai-responses",
    },
    models: buildXaiCatalogModels(),
    apiKey: params.apiKey,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    ttlMs: XAI_MODELS_CACHE_TTL_MS,
    auditContext: "xai-model-discovery",
  });
  // Multi-agent models reject the client-side tools every OpenClaw agent turn sends.
  return {
    ...provider,
    models: provider.models.filter((model) => !model.id.toLowerCase().includes("multi-agent")),
  };
}

function isXaiOAuthResponsesModel(
  row: unknown,
  modelId: string,
  fallback: ModelDefinitionConfig | undefined,
) {
  if ((XAI_IMAGE_MODELS as readonly string[]).includes(modelId)) {
    return false;
  }
  const backend =
    readLiveModelCatalogStringField(row, "api_backend") ??
    readLiveModelCatalogStringField(row, "apiBackend") ??
    readLiveModelCatalogStringField(row, "backend");
  if (backend) {
    const normalizedBackend = backend.toLowerCase();
    return (
      normalizedBackend === "responses" ||
      normalizedBackend === "chat" ||
      normalizedBackend === "language"
    );
  }
  return Boolean(fallback);
}

function buildXaiOauthModelFromLiveRow(row: unknown): ModelDefinitionConfig | undefined {
  const modelId =
    readLiveModelCatalogStringField(row, "id") ?? readLiveModelCatalogStringField(row, "model");
  if (!modelId) {
    return undefined;
  }
  const fallback = resolveXaiCatalogEntry(modelId === "grok-build" ? "grok-build-0.1" : modelId);
  if (!isXaiOAuthResponsesModel(row, modelId, fallback)) {
    return undefined;
  }
  const contextWindow =
    readLiveModelCatalogPositiveSafeIntegerField(row, ["context_window", "contextWindow"]) ??
    fallback?.contextWindow ??
    XAI_DEFAULT_CONTEXT_WINDOW;
  const maxTokens =
    readLiveModelCatalogPositiveSafeIntegerField(row, [
      "max_completion_tokens",
      "maxCompletionTokens",
    ]) ??
    fallback?.maxTokens ??
    XAI_DEFAULT_MAX_TOKENS;
  const supportsReasoningEffort =
    readLiveModelCatalogBooleanField(row, "supports_reasoning_effort") ??
    readLiveModelCatalogBooleanField(row, "supportsReasoningEffort");
  const reasoning =
    supportsReasoningEffort === true ||
    fallback?.reasoning === true ||
    XAI_GROK_OAUTH_REASONING_MODEL_IDS.has(modelId);
  // The listing names each model's selectable efforts; carry them so the thinking
  // profile and request compat follow the account instead of model-ID rules.
  const listedEfforts =
    row && typeof row === "object" && "reasoning_efforts" in row
      ? row.reasoning_efforts
      : undefined;
  const supportedReasoningEfforts =
    supportsReasoningEffort === true && Array.isArray(listedEfforts)
      ? normalizeXaiReasoningEfforts(
          listedEfforts.map((entry) =>
            entry && typeof entry === "object" && "value" in entry ? entry.value : entry,
          ),
        )
      : [];
  const compat =
    supportedReasoningEfforts.length > 0
      ? { ...fallback?.compat, supportedReasoningEfforts }
      : fallback?.compat;

  return {
    id: modelId,
    name: readLiveModelCatalogStringField(row, "name") ?? fallback?.name ?? modelId,
    api: "openai-responses",
    baseUrl: XAI_GROK_OAUTH_BASE_URL,
    reasoning,
    input: fallback?.input ?? ["text"],
    cost: fallback?.cost ?? XAI_UNKNOWN_MODEL_COST,
    contextWindow,
    maxTokens,
    ...(compat ? { compat } : {}),
    ...(fallback?.thinkingLevelMap ? { thinkingLevelMap: fallback.thinkingLevelMap } : {}),
  };
}

export async function buildLiveXaiOAuthProvider(params: {
  discoveryApiKey: string;
  authMode?: "oauth" | "token";
  fetchGuard?: LiveModelCatalogFetchGuard;
  signal?: AbortSignal;
}): Promise<ModelProviderConfig> {
  const { models, ...providerConfig } = buildXaiProvider(
    "openai-responses",
    params.authMode ?? "oauth",
  );
  return await buildLiveModelProviderConfig({
    discoveryMode: "strict",
    providerId: PROVIDER_ID,
    endpoint: XAI_GROK_OAUTH_MODELS_ENDPOINT,
    providerConfig,
    models,
    discoveryApiKey: params.discoveryApiKey,
    fetchGuard: params.fetchGuard,
    signal: params.signal,
    ttlMs: XAI_GROK_OAUTH_MODELS_CACHE_TTL_MS,
    auditContext: "xai-grok-oauth-model-discovery",
    cacheKeyParts: [
      PROVIDER_ID,
      "grok-oauth-model-rows",
      XAI_GROK_OAUTH_MODELS_ENDPOINT,
      params.discoveryApiKey,
    ],
    projectRows: (rows) =>
      rows
        .map(buildXaiOauthModelFromLiveRow)
        .filter((model): model is ModelDefinitionConfig => Boolean(model)),
  });
}
