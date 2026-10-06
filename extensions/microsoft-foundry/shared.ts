import type { AuthConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  buildApiKeyCredential,
  type ProviderAuthResult,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import {
  resolveClaudeFable5ModelIdentity,
  supportsClaudeAdaptiveThinking,
  supportsClaudeNativeXhighEffort,
  type ModelApi,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";

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
};

function isAnthropicFoundryDeployment(modelName?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(modelName);
  return normalized ? normalized.startsWith("claude") : false;
}

export function usesFoundryResponsesByDefault(value?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
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
  const normalized = normalizeOptionalLowercaseString(value);
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
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized === "mai-ds-r1" || normalized === "mai-thinking-1";
}

function supportsFoundryImageInput(value?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
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
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized
    ? normalized === "claude-mythos-preview" || normalized.startsWith("claude-mythos-")
    : false;
}

export function requiresFoundryMandatoryAdaptiveClaudeThinking(value?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  return normalized
    ? resolveClaudeFable5ModelIdentity({ id: normalized }) !== undefined ||
        normalized === "claude-mythos-preview" ||
        normalized.startsWith("claude-mythos-")
    : false;
}

function supportsFoundryManualClaudeThinking(value?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(value)?.replace(/\./g, "-");
  return normalized
    ? /(?:^|-)claude-(?:opus-4-(?:1|5)|sonnet-4-5|haiku-4-5)(?=$|[^a-z0-9])/.test(normalized)
    : false;
}

function resolveFoundryOpenAIModelTokenLimits(
  normalized: string | undefined,
): { contextWindow: number; maxTokens: number } | undefined {
  if (!normalized) {
    return undefined;
  }
  // Foundry publishes provider-native capacities. Keep exact families here so
  // older GPT and continuously updated chat models retain their separate caps.
  if (/^gpt-5\.(?:4(?:-pro)?|5|6(?:-(?:sol|terra|luna))?)$/u.test(normalized)) {
    return { contextWindow: 1_050_000, maxTokens: 128_000 };
  }
  if (/^gpt-5\.4-(?:mini|nano)$/u.test(normalized)) {
    return { contextWindow: 400_000, maxTokens: 128_000 };
  }
  return undefined;
}

function resolveFoundryModelTokenLimits(value?: string | null): {
  contextWindow: number;
  maxTokens: number;
} {
  const normalized = normalizeOptionalLowercaseString(value);
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
  return { contextWindow: 128_000, maxTokens: 16_384 };
}

export function requiresFoundryMaxCompletionTokens(value?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized) {
    return false;
  }
  return (
    normalized.startsWith("gpt-5") ||
    normalized.startsWith("o1") ||
    normalized.startsWith("o3") ||
    normalized.startsWith("o4")
  );
}

function supportsFoundryReasoningEffort(value?: string | null): boolean {
  const normalized = normalizeOptionalLowercaseString(value);
  if (
    !normalized ||
    /^gpt-5-chat(?:-|$)/u.test(normalized) ||
    /^o1-mini(?:-|$)/u.test(normalized)
  ) {
    return false;
  }
  return requiresFoundryMaxCompletionTokens(normalized);
}

function resolveFoundryReasoningEfforts(value?: string | null): string[] | undefined {
  const normalized = normalizeOptionalLowercaseString(value);
  if (!normalized || !supportsFoundryReasoningEffort(normalized)) {
    return undefined;
  }
  if (normalized === "gpt-5.1-codex-max") {
    return ["none", "medium", "high", "xhigh"];
  }
  if (normalized === "gpt-5-pro") {
    return ["high"];
  }
  if (/^gpt-5\.[2-9](?:\.|-|$)/u.test(normalized) || /^gpt-5\.1(?:-|$)/u.test(normalized)) {
    return ["none", "low", "medium", "high"];
  }
  if (/^gpt-5-codex(?:-|$)/u.test(normalized)) {
    return ["low", "medium", "high"];
  }
  if (/^gpt-5(?:-|$)/u.test(normalized)) {
    return ["minimal", "low", "medium", "high"];
  }
  return ["low", "medium", "high"];
}

function buildFoundryThinkingLevelMap(efforts: string[]): Record<string, string | null> {
  const supported = new Set(efforts);
  return {
    off: supported.has("none") ? "none" : null,
    minimal: supported.has("minimal") ? "minimal" : null,
    low: supported.has("low") ? "low" : null,
    medium: supported.has("medium") ? "medium" : null,
    high: supported.has("high") ? "high" : null,
    xhigh: supported.has("xhigh") ? "xhigh" : null,
    max: null,
  };
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
  const parsed = URL.parse(trimmed);
  if (parsed) {
    const normalizedPath = parsed.pathname
      .replace(/\/(?:openai|anthropic)(?:$|\/).*/i, "")
      .replace(/\/+$/, "");
    return `${parsed.origin}${normalizedPath && normalizedPath !== "/" ? normalizedPath : ""}`;
  }
  const withoutQuery = trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return withoutQuery.replace(/\/(?:openai|anthropic)(?:$|\/).*/i, "");
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
  const base = normalizeFoundryEndpoint(endpoint);
  const path = resolvedApi === ANTHROPIC_MESSAGES_API ? "/anthropic" : "/openai/v1";
  return base.endsWith(path) ? base : `${base}${path}`;
}

export function extractFoundryEndpoint(baseUrl: string | null | undefined): string | undefined {
  const trimmed = normalizeOptionalString(baseUrl);
  if (!trimmed) {
    return undefined;
  }
  const parsed = URL.parse(trimmed);
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) {
    return undefined;
  }
  return normalizeFoundryEndpoint(trimmed) || undefined;
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
  const supportedReasoningEfforts = resolveFoundryReasoningEfforts(modelName);
  const supportsReasoningEffort = supportsFoundryReasoningEffort(modelName);
  const isAnthropic = api === ANTHROPIC_MESSAGES_API || isAnthropicFoundryDeployment(modelName);
  const supportsClaudeThinking =
    isAnthropic &&
    (supportsClaudeAdaptiveThinking({ id: modelName }) ||
      supportsFoundryManualClaudeThinking(modelName) ||
      requiresFoundryMandatoryAdaptiveClaudeThinking(modelName));
  const supportsClaudeXhighThinking =
    isAnthropic && supportsClaudeNativeXhighEffort({ id: modelName });
  const tokenLimits = resolveFoundryModelTokenLimits(modelName);
  return {
    modelName,
    api,
    reasoning:
      supportsClaudeThinking ||
      supportsReasoningEffort ||
      supportsFoundryReasoningContent(modelName),
    ...(supportsClaudeXhighThinking
      ? { thinkingLevelMap: { xhigh: "xhigh", max: "max" } }
      : supportedReasoningEfforts
        ? { thinkingLevelMap: buildFoundryThinkingLevelMap(supportedReasoningEfforts) }
        : {}),
    input:
      normalizedInput.includes("image") || supportsFoundryImageInput(modelName)
        ? ["text", "image"]
        : normalizedInput,
    contextWindow: tokenLimits.contextWindow,
    maxTokens: tokenLimits.maxTokens,
    compat:
      api === ANTHROPIC_MESSAGES_API
        ? undefined
        : {
            ...(api === DEFAULT_GPT5_API ? { supportsStore: false } : {}),
            ...(api !== DEFAULT_GPT5_API || supportsReasoningEffort
              ? { supportsReasoningEffort }
              : {}),
            ...(supportedReasoningEfforts ? { supportedReasoningEfforts } : {}),
            maxTokensField: requiresFoundryMaxCompletionTokens(modelName)
              ? "max_completion_tokens"
              : "max_tokens",
          },
  };
}

export function resolveConfiguredModelNameHint(
  modelId: string,
  modelNameHint?: string | null,
): string | undefined {
  return normalizeOptionalString(modelNameHint) ?? normalizeOptionalString(modelId);
}

export function buildFoundryModelConfig(
  endpoint: string,
  modelId: string,
  capabilities: FoundryModelCapabilities,
): ModelDefinitionConfig {
  return {
    id: modelId,
    name: capabilities.modelName,
    api: capabilities.api,
    baseUrl: buildFoundryProviderBaseUrl(
      endpoint,
      modelId,
      capabilities.modelName,
      capabilities.api,
    ),
    reasoning: capabilities.reasoning,
    ...(capabilities.thinkingLevelMap ? { thinkingLevelMap: capabilities.thinkingLevelMap } : {}),
    params: { canonicalModelId: capabilities.modelName },
    input: capabilities.input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
    ...(capabilities.compat ? { compat: capabilities.compat } : {}),
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
  const selectedDeployment = params.deployments?.find(({ name }) => name === params.modelId);
  const imageDeployment = isFoundryMaiImageModel(
    resolveConfiguredModelNameHint(
      params.modelId,
      selectedDeployment?.modelName ?? params.modelNameHint,
    ),
  );
  const resolvedApi = resolveFoundryApi(params.modelId, params.modelNameHint, params.api);
  const deployments = params.deployments?.length
    ? params.deployments
    : [{ name: params.modelId, modelName: params.modelNameHint ?? undefined, api: resolvedApi }];
  const modelName = resolveConfiguredModelNameHint(params.modelId, params.modelNameHint);
  const metadata = {
    authMethod: params.authMethod,
    endpoint: params.endpoint,
    modelId: params.modelId,
    api: resolvedApi,
    ...(modelName ? { modelName } : {}),
    ...(params.subscriptionId ? { subscriptionId: params.subscriptionId } : {}),
    ...(params.subscriptionName ? { subscriptionName: params.subscriptionName } : {}),
    ...(params.tenantId ? { tenantId: params.tenantId } : {}),
  };
  const modelRef = `${PROVIDER_ID}/${params.modelId}`;
  return {
    profiles: [
      {
        profileId: params.profileId,
        credential: buildApiKeyCredential(
          PROVIDER_ID,
          params.apiKey,
          metadata,
          params.secretInputMode ? { secretInputMode: params.secretInputMode } : undefined,
        ),
      },
    ],
    configPatch: {
      auth: {
        order: {
          [PROVIDER_ID]: [
            params.profileId,
            ...(params.currentProviderProfileIds ?? []).filter(
              (profileId) => profileId !== params.profileId,
            ),
          ],
        },
      },
      ...(imageDeployment
        ? { agents: { defaults: { mediaModels: { image: { primary: modelRef } } } } }
        : {}),
      models: {
        providers: {
          [PROVIDER_ID]: {
            baseUrl: buildFoundryProviderBaseUrl(
              params.endpoint,
              params.modelId,
              params.modelNameHint,
              resolvedApi,
            ),
            api: resolvedApi,
            authHeader: undefined,
            apiKey: undefined,
            headers: undefined,
            models: deployments.map((deployment) =>
              buildFoundryModelConfig(
                params.endpoint,
                deployment.name,
                resolveFoundryModelCapabilities(
                  deployment.name,
                  deployment.modelName,
                  deployment.api ?? resolvedApi,
                ),
              ),
            ),
          },
        },
      },
      ...(Array.isArray(params.currentPluginsAllow) &&
      params.currentPluginsAllow.length > 0 &&
      !params.currentPluginsAllow.includes(PROVIDER_ID)
        ? { plugins: { allow: [...params.currentPluginsAllow, PROVIDER_ID] } }
        : {}),
    },
    ...(!imageDeployment ? { defaultModel: modelRef } : {}),
    notes: params.notes,
  };
}

export function resolveFoundryTargetProfileId(config: FoundryConfigShape): string | undefined {
  const profileIds = listConfiguredFoundryProfileIds(config);
  if (profileIds.length === 0) {
    return undefined;
  }
  // Prefer the explicitly ordered profile; fall back to the sole entry when there is exactly one.
  return (
    config.auth?.order?.[PROVIDER_ID]?.find((profileId) => normalizeOptionalString(profileId)) ??
    (profileIds.length === 1 ? profileIds[0] : undefined)
  );
}
