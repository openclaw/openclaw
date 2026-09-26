// Microsoft Foundry plugin module implements shared behavior.
import type { AuthConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  type ProviderAuthResult,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  resolveClaudeFable5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
  type ModelApi,
  type ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeFoundryModelName,
  resolveFoundryOpenAIModelTokenLimits,
  requiresFoundryMaxCompletionTokens,
  supportsFoundryReasoningEffort,
  resolveFoundryReasoningEfforts,
  buildFoundryThinkingLevelMap,
} from "./model-metadata.js";

export { requiresFoundryMaxCompletionTokens } from "./model-metadata.js";

export const PROVIDER_ID = "microsoft-foundry";
export const DEFAULT_API = "openai-completions";
export const DEFAULT_GPT5_API = "openai-responses";
export const ANTHROPIC_MESSAGES_API = "anthropic-messages";
export const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
export const FOUNDRY_ANTHROPIC_SCOPE = "https://ai.azure.com/.default";
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AzAccount {
  name: string;
  id: string;
  tenantId?: string;
  user?: { name?: string };
  state?: string;
  isDefault?: boolean;
}

export interface AzAccessToken {
  accessToken: string;
  expiresOn?: string;
}

export interface AzCognitiveAccount {
  id: string;
  name: string;
  kind: string;
  location?: string;
  resourceGroup?: string;
  endpoint?: string | null;
  customSubdomain?: string | null;
  projects?: string[] | null;
}

export interface FoundryResourceOption {
  id: string;
  accountName: string;
  kind: "AIServices" | "OpenAI";
  location?: string;
  resourceGroup: string;
  endpoint: string;
  projects: string[];
}

export interface AzDeploymentSummary {
  name: string;
  modelName?: string;
  modelVersion?: string;
  state?: string;
  sku?: string;
}

export type FoundrySelection = {
  endpoint: string;
  modelId: string;
  modelNameHint?: string;
  api: FoundryProviderApi;
};

export type CachedTokenEntry = {
  token: string;
  expiresAt: number;
};

export type FoundryProviderApi =
  | typeof DEFAULT_API
  | typeof DEFAULT_GPT5_API
  | typeof ANTHROPIC_MESSAGES_API;

type FoundryDeploymentConfigInput = {
  name: string;
  modelName?: string;
  api?: FoundryProviderApi;
};

type FoundryModelCapabilities = {
  modelName: string;
  api: FoundryProviderApi;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
  compat?: FoundryModelCompat;
};

type FoundryProviderConfigPatch = Omit<ModelProviderConfig, "apiKey" | "headers"> & {
  apiKey?: SecretInput | undefined;
  headers?: Record<string, SecretInput> | undefined;
};

function normalizeModelInput(input?: unknown): Array<"text" | "image"> {
  const normalized = Array.isArray(input)
    ? input.filter((item): item is "text" | "image" => item === "text" || item === "image")
    : [];
  return normalized.length > 0 ? normalized : ["text"];
}

type FoundryModelCompat = {
  supportsStore?: boolean;
  supportsReasoningEffort?: boolean;
  supportedReasoningEfforts?: string[];
  maxTokensField: "max_completion_tokens" | "max_tokens";
};

type FoundryConfigShape = {
  auth?: AuthConfig;
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
};

function isAnthropicFoundryDeployment(modelName?: string | null): boolean {
  const normalized = normalizeFoundryModelName(modelName);
  return normalized ? normalized.startsWith("claude") : false;
}

export function usesFoundryResponsesByDefault(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized.startsWith("deepseek-v4") ||
    normalized === "computer-use-preview"
  );
}

export function isFoundryMaiImageModel(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized === "mai-image-2.5-flash" ||
    normalized === "mai-image-2.5" ||
    normalized === "mai-image-2e" ||
    normalized === "mai-image-2" ||
    normalized === "mai-image-2-efficient"
  );
}

function supportsFoundryReasoningContent(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  return normalized === "mai-ds-r1" || normalized === "mai-thinking-1";
}

function supportsFoundryImageInput(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  if (!normalized) {
    return false;
  }
  return (
    isAnthropicFoundryDeployment(normalized) ||
    normalized.startsWith("gpt-") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4") ||
    normalized === "computer-use-preview"
  );
}

export function requiresFoundryEntraIdClaudeAuth(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  return normalized
    ? normalized === "claude-mythos-preview" || normalized.startsWith("claude-mythos-")
    : false;
}

export function requiresFoundryMandatoryAdaptiveClaudeThinking(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value);
  return normalized
    ? resolveClaudeFable5ModelIdentity({ id: normalized }) !== undefined ||
        normalized === "claude-mythos-preview" ||
        normalized.startsWith("claude-mythos-")
    : false;
}

function supportsFoundryManualClaudeThinking(value?: string | null): boolean {
  const normalized = normalizeFoundryModelName(value)?.replace(/\./g, "-");
  return normalized
    ? /(?:^|-)claude-(?:opus-4-(?:1|5)|sonnet-4-5|haiku-4-5)(?=$|[^a-z0-9])/.test(normalized)
    : false;
}

function resolveFoundryModelTokenLimits(value?: string | null):
  | {
      contextWindow: number;
      maxTokens: number;
    }
  | undefined {
  const normalized = normalizeFoundryModelName(value);
  const normalizedVersion = normalized?.replace(/\./g, "-");
  const foundryOpenAILimits = resolveFoundryOpenAIModelTokenLimits(normalized);
  if (foundryOpenAILimits) {
    return foundryOpenAILimits;
  }
  if (
    normalized &&
    (supportsClaudeAdaptiveThinking({ id: normalized }) ||
      requiresFoundryMandatoryAdaptiveClaudeThinking(normalized))
  ) {
    return { contextWindow: 1_000_000, maxTokens: 128_000 };
  }
  if (
    normalizedVersion === "claude-opus-4-5" ||
    normalizedVersion === "claude-sonnet-4-5" ||
    normalizedVersion === "claude-haiku-4-5"
  ) {
    return { contextWindow: 200_000, maxTokens: 64_000 };
  }
  if (normalizedVersion === "claude-opus-4-1") {
    return { contextWindow: 200_000, maxTokens: 32_000 };
  }
  if (normalized === "mai-ds-r1") {
    return { contextWindow: 163_840, maxTokens: 163_840 };
  }
  return undefined;
}

export function isFoundryProviderApi(value?: string | null): value is FoundryProviderApi {
  return value === DEFAULT_API || value === DEFAULT_GPT5_API || value === ANTHROPIC_MESSAGES_API;
}

export function formatFoundryApiLabel(api: FoundryProviderApi): string {
  return api === DEFAULT_GPT5_API
    ? "Responses"
    : api === ANTHROPIC_MESSAGES_API
      ? "Anthropic Messages"
      : "Chat Completions";
}

export function normalizeFoundryEndpoint(endpoint: string): string {
  const trimmed = normalizeOptionalString(endpoint) ?? "";
  if (!trimmed) {
    return trimmed;
  }
  try {
    const parsed = new URL(trimmed);
    parsed.search = "";
    parsed.hash = "";
    const normalizedPath = parsed.pathname
      .replace(/\/(?:openai|anthropic)(?:$|\/).*/i, "")
      .replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath && normalizedPath !== "/" ? normalizedPath : ""}`;
  } catch {
    const withoutQuery = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
    return withoutQuery.replace(/\/(?:openai|anthropic)(?:$|\/).*/i, "");
  }
}

function buildFoundryV1BaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
}

function buildFoundryAnthropicBaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith("/anthropic") ? base : `${base}/anthropic`;
}

export function resolveFoundryApi(
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
): FoundryProviderApi {
  if (isFoundryProviderApi(configuredApi)) {
    return configuredApi;
  }
  const configuredModelName = resolveConfiguredModelNameHint(modelId, modelNameHint);
  if (isAnthropicFoundryDeployment(configuredModelName)) {
    return ANTHROPIC_MESSAGES_API;
  }
  return usesFoundryResponsesByDefault(configuredModelName) ? DEFAULT_GPT5_API : DEFAULT_API;
}

export function buildFoundryProviderBaseUrl(
  endpoint: string,
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
): string {
  const resolvedApi = resolveFoundryApi(modelId, modelNameHint, configuredApi);
  return resolvedApi === ANTHROPIC_MESSAGES_API
    ? buildFoundryAnthropicBaseUrl(endpoint)
    : buildFoundryV1BaseUrl(endpoint);
}

export function extractFoundryEndpoint(baseUrl: string | null | undefined): string | undefined {
  const trimmed = normalizeOptionalString(baseUrl);
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return undefined;
    }
    return normalizeFoundryEndpoint(trimmed) || undefined;
  } catch {
    return undefined;
  }
}

function buildFoundryModelCompat(
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
): FoundryModelCompat | undefined {
  const resolvedApi = resolveFoundryApi(modelId, modelNameHint, configuredApi);
  if (resolvedApi === ANTHROPIC_MESSAGES_API) {
    return undefined;
  }
  const configuredModelName = resolveConfiguredModelNameHint(modelId, modelNameHint);
  const needsMaxCompletionTokens = requiresFoundryMaxCompletionTokens(configuredModelName);
  const supportsReasoningEffort = supportsFoundryReasoningEffort(configuredModelName);
  const supportedReasoningEfforts = resolveFoundryReasoningEfforts(
    configuredModelName,
    resolvedApi,
  );
  if (resolvedApi !== DEFAULT_GPT5_API) {
    return {
      supportsReasoningEffort,
      ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
      maxTokensField: needsMaxCompletionTokens ? "max_completion_tokens" : "max_tokens",
    };
  }
  return {
    ...(resolvedApi === DEFAULT_GPT5_API ? { supportsStore: false } : {}),
    ...(supportsReasoningEffort ? { supportsReasoningEffort, supportedReasoningEfforts } : {}),
    maxTokensField: needsMaxCompletionTokens ? "max_completion_tokens" : "max_tokens",
  };
}

export function resolveFoundryModelCapabilities(
  modelId: string,
  modelNameHint?: string | null,
  configuredApi?: ModelApi | null,
  existingInput?: unknown,
): FoundryModelCapabilities {
  const modelName = resolveConfiguredModelNameHint(modelId, modelNameHint) ?? modelId;
  const api = resolveFoundryApi(modelId, modelName, configuredApi);
  const normalizedInput = normalizeModelInput(existingInput);
  const supportedReasoningEfforts = resolveFoundryReasoningEfforts(modelName, api);
  const isAnthropic = api === ANTHROPIC_MESSAGES_API || isAnthropicFoundryDeployment(modelName);
  const supportsClaudeThinking =
    isAnthropic &&
    (supportsClaudeAdaptiveThinking({ id: modelName }) ||
      supportsFoundryManualClaudeThinking(modelName) ||
      requiresFoundryMandatoryAdaptiveClaudeThinking(modelName));
  const supportsClaudeXhighThinking =
    isAnthropic && supportsClaudeNativeXhighEffort({ id: modelName });
  const tokenLimits = resolveFoundryModelTokenLimits(modelName) ?? {
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
  return {
    modelName,
    api,
    reasoning:
      supportsClaudeThinking ||
      supportsFoundryReasoningEffort(modelName) ||
      supportsFoundryReasoningContent(modelName),
    ...(supportsClaudeXhighThinking
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : supportedReasoningEfforts
        ? { thinkingLevelMap: buildFoundryThinkingLevelMap(supportedReasoningEfforts, modelName) }
        : {}),
    input:
      normalizedInput.includes("image") || supportsFoundryImageInput(modelName)
        ? ["text", "image"]
        : normalizedInput,
    contextWindow: tokenLimits.contextWindow,
    maxTokens: tokenLimits.maxTokens,
    compat: buildFoundryModelCompat(modelId, modelName, api),
  };
}

export function mergeFoundryCanonicalModelParams(
  params: Record<string, unknown> | undefined,
  modelName: string,
): Record<string, unknown> {
  return {
    ...params,
    canonicalModelId: modelName,
  };
}

export function resolveConfiguredModelNameHint(
  modelId: string,
  modelNameHint?: string | null,
): string | undefined {
  const trimmedName = normalizeOptionalString(modelNameHint) ?? "";
  if (trimmedName) {
    return trimmedName;
  }
  const trimmedId = normalizeOptionalString(modelId) ?? "";
  return trimmedId ? trimmedId : undefined;
}

function buildFoundryProviderConfig(
  endpoint: string,
  modelId: string,
  modelNameHint?: string | null,
  options?: {
    api?: FoundryProviderApi;
    deployments?: FoundryDeploymentConfigInput[];
  },
): FoundryProviderConfigPatch {
  const resolvedApi = resolveFoundryApi(modelId, modelNameHint, options?.api);
  const deployments = options?.deployments?.length
    ? options.deployments
    : [{ name: modelId, modelName: modelNameHint ?? undefined, api: resolvedApi }];
  return {
    baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint, resolvedApi),
    api: resolvedApi,
    authHeader: undefined,
    apiKey: undefined,
    headers: undefined,
    models: deployments.map((deployment) => {
      const capabilities = resolveFoundryModelCapabilities(
        deployment.name,
        deployment.modelName,
        deployment.api ?? resolvedApi,
      );
      const modelBaseUrl = buildFoundryProviderBaseUrl(
        endpoint,
        deployment.name,
        capabilities.modelName,
        capabilities.api,
      );
      return Object.assign(
        {
          id: deployment.name,
          name: capabilities.modelName,
          api: capabilities.api,
          baseUrl: modelBaseUrl,
          reasoning: capabilities.reasoning,
          ...(capabilities.thinkingLevelMap
            ? { thinkingLevelMap: capabilities.thinkingLevelMap }
            : {}),
          params: mergeFoundryCanonicalModelParams(undefined, capabilities.modelName),
          input: capabilities.input,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: capabilities.contextWindow,
          maxTokens: capabilities.maxTokens,
        },
        capabilities.compat ? { compat: capabilities.compat } : {},
      );
    }),
  };
}

function resolveSelectedDeploymentModelName(params: {
  modelId: string;
  modelNameHint?: string | null;
  deployments?: FoundryDeploymentConfigInput[];
}): string | undefined {
  const selectedDeployment = params.deployments?.find(
    (deployment) => deployment.name === params.modelId,
  );
  return resolveConfiguredModelNameHint(
    params.modelId,
    selectedDeployment?.modelName ?? params.modelNameHint,
  );
}

function isSelectedMaiImageDeployment(params: {
  modelId: string;
  modelNameHint?: string | null;
  deployments?: FoundryDeploymentConfigInput[];
}): boolean {
  return isFoundryMaiImageModel(resolveSelectedDeploymentModelName(params));
}

function buildFoundryImageDefaultPatch(params: {
  modelId: string;
  modelNameHint?: string | null;
  deployments?: FoundryDeploymentConfigInput[];
}) {
  if (!isSelectedMaiImageDeployment(params)) {
    return {};
  }
  return {
    agents: {
      defaults: {
        mediaModels: {
          image: {
            primary: `${PROVIDER_ID}/${params.modelId}`,
          },
        },
      },
    },
  };
}

function buildFoundryCredentialMetadata(params: {
  authMethod: "api-key" | "entra-id";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  api?: FoundryProviderApi;
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
}): Record<string, string> {
  const resolvedApi = resolveFoundryApi(params.modelId, params.modelNameHint, params.api);
  const metadata: Record<string, string> = {
    authMethod: params.authMethod,
    endpoint: params.endpoint,
    modelId: params.modelId,
    api: resolvedApi,
  };
  const modelName = resolveConfiguredModelNameHint(params.modelId, params.modelNameHint);
  if (modelName) {
    metadata.modelName = modelName;
  }
  if (params.subscriptionId) {
    metadata.subscriptionId = params.subscriptionId;
  }
  if (params.subscriptionName) {
    metadata.subscriptionName = params.subscriptionName;
  }
  if (params.tenantId) {
    metadata.tenantId = params.tenantId;
  }
  return metadata;
}

/**
 * Build the plugins.allow patch so the provider is allowlisted when the
 * config already gates plugins via a non-empty allow array.  Returns an
 * empty object when no patch is needed (allowlist absent / already listed).
 */
function buildPluginsAllowPatch(
  currentAllow: string[] | undefined,
): { plugins: { allow: string[] } } | Record<string, never> {
  if (!Array.isArray(currentAllow) || currentAllow.length === 0) {
    return {};
  }
  if (currentAllow.includes(PROVIDER_ID)) {
    return {};
  }
  return { plugins: { allow: [...currentAllow, PROVIDER_ID] } };
}

function buildFoundryAuthOrderPatch(params: {
  profileId: string;
  currentProviderProfileIds?: string[];
}): { auth: { order: Record<string, string[]> } } {
  const nextOrder = [
    params.profileId,
    ...(params.currentProviderProfileIds ?? []).filter(
      (profileId) => profileId !== params.profileId,
    ),
  ];
  return {
    auth: {
      order: {
        [PROVIDER_ID]: nextOrder,
      },
    },
  };
}

export function listConfiguredFoundryProfileIds(config: FoundryConfigShape): string[] {
  return Object.entries(config.auth?.profiles ?? {})
    .filter(([, profile]) => profile.provider === PROVIDER_ID)
    .map(([profileId]) => profileId);
}

export function buildFoundryAuthResult(params: {
  profileId: string;
  apiKey: SecretInput;
  secretInputMode?: "plaintext" | "ref";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  api: FoundryProviderApi;
  authMethod: "api-key" | "entra-id";
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  notes?: string[];
  /** Current plugins.allow so the provider can self-allowlist during onboard. */
  currentPluginsAllow?: string[];
  currentProviderProfileIds?: string[];
  deployments?: FoundryDeploymentConfigInput[];
}): ProviderAuthResult {
  const imageDefaultPatch = buildFoundryImageDefaultPatch(params);
  const providerConfig = buildFoundryProviderConfig(
    params.endpoint,
    params.modelId,
    params.modelNameHint,
    { api: params.api, deployments: params.deployments },
  );
  const fallbackModels = providerConfig.models.filter(
    (model) => !isFoundryMaiImageModel(model.name) && !resolveFoundryModelTokenLimits(model.name),
  );
  const notes = [...(params.notes ?? [])];
  if (fallbackModels.length > 0) {
    notes.push(
      `Unverified model limits for Foundry deployments: ${fallbackModels.map((model) => model.id).join(", ")}. ` +
        "Using 128,000 context and 16,384 output tokens. Verify the deployed model's limits and reasoning support, " +
        "then set contextWindow, maxTokens, reasoning, thinkingLevelMap, and compat.supportedReasoningEfforts " +
        "in models.providers.microsoft-foundry.models as needed.",
    );
  }
  const defaultModel = isSelectedMaiImageDeployment(params)
    ? undefined
    : `${PROVIDER_ID}/${params.modelId}`;
  return {
    profiles: [
      {
        profileId: params.profileId,
        credential: buildApiKeyCredential(
          PROVIDER_ID,
          params.apiKey,
          buildFoundryCredentialMetadata({
            authMethod: params.authMethod,
            endpoint: params.endpoint,
            modelId: params.modelId,
            modelNameHint: params.modelNameHint,
            api: params.api,
            subscriptionId: params.subscriptionId,
            subscriptionName: params.subscriptionName,
            tenantId: params.tenantId,
          }),
          params.secretInputMode ? { secretInputMode: params.secretInputMode } : undefined,
        ),
      },
    ],
    configPatch: {
      ...buildFoundryAuthOrderPatch({
        profileId: params.profileId,
        currentProviderProfileIds: params.currentProviderProfileIds,
      }),
      ...imageDefaultPatch,
      models: {
        providers: {
          [PROVIDER_ID]: providerConfig,
        },
      },
      ...buildPluginsAllowPatch(params.currentPluginsAllow),
    },
    ...(defaultModel ? { defaultModel } : {}),
    notes: notes.length > 0 ? notes : params.notes,
  };
}

export function applyFoundryProfileBinding(config: FoundryConfigShape, profileId: string): void {
  const next = applyAuthProfileConfig(config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "api_key",
  });
  config.auth = next.auth;
}

export function applyFoundryProviderConfig(
  config: FoundryConfigShape,
  providerConfig: ModelProviderConfig,
): void {
  config.models ??= {};
  config.models.providers ??= {};
  config.models.providers[PROVIDER_ID] = providerConfig;
}

export function resolveFoundryTargetProfileId(config: FoundryConfigShape): string | undefined {
  const configuredProfiles = config.auth?.profiles ?? {};
  const configuredProfileEntries = Object.entries(configuredProfiles).filter(([, profile]) => {
    return profile.provider === PROVIDER_ID;
  });
  if (configuredProfileEntries.length === 0) {
    return undefined;
  }
  // Prefer the explicitly ordered profile; fall back to the sole entry when there is exactly one.
  return (
    config.auth?.order?.[PROVIDER_ID]?.find((profileId) => normalizeOptionalString(profileId)) ??
    (configuredProfileEntries.length === 1 ? configuredProfileEntries[0]?.[0] : undefined)
  );
}
