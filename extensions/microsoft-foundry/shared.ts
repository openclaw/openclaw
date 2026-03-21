import {
  applyAuthProfileConfig,
  buildApiKeyCredential,
  ensureAuthProfileStore,
  type ProviderAuthResult,
  type SecretInput,
} from "openclaw/plugin-sdk/provider-auth";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-models";

export const PROVIDER_ID = "microsoft-foundry";
export const DEFAULT_API = "openai-completions";
export const DEFAULT_GPT5_API = "openai-responses";
export const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
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
};

export type CachedTokenEntry = {
  token: string;
  expiresAt: number;
};

export type FoundryProviderApi = typeof DEFAULT_API | typeof DEFAULT_GPT5_API;

type FoundryModelCompat = {
  maxTokensField: "max_completion_tokens" | "max_tokens";
};

type FoundryAuthProfileConfig = {
  provider: string;
  mode: "api_key" | "oauth" | "token";
  email?: string;
};

type FoundryConfigShape = {
  auth?: {
    profiles?: Record<string, FoundryAuthProfileConfig>;
    order?: Record<string, string[]>;
  };
  models?: {
    providers?: Record<string, ModelProviderConfig>;
  };
};

export function isGpt5FamilyName(value?: string | null): boolean {
  return typeof value === "string" && /^gpt-5(?:$|[-.])/i.test(value.trim());
}

export function isGpt5FamilyDeployment(modelId: string, modelNameHint?: string | null): boolean {
  return isGpt5FamilyName(modelId) || isGpt5FamilyName(modelNameHint);
}

export function normalizeFoundryEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/openai(?:\/v1|\/deployments\/[^/]+)?$/i, "");
}

export function buildAzureBaseUrl(endpoint: string, modelId: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  if (base.includes("/openai/deployments/")) return base;
  return `${base}/openai/deployments/${modelId}`;
}

export function buildFoundryResponsesBaseUrl(endpoint: string): string {
  const base = normalizeFoundryEndpoint(endpoint);
  return base.endsWith("/openai/v1") ? base : `${base}/openai/v1`;
}

export function resolveFoundryApi(
  modelId: string,
  modelNameHint?: string | null,
): FoundryProviderApi {
  return isGpt5FamilyDeployment(modelId, modelNameHint) ? DEFAULT_GPT5_API : DEFAULT_API;
}

export function buildFoundryProviderBaseUrl(
  endpoint: string,
  modelId: string,
  modelNameHint?: string | null,
): string {
  return resolveFoundryApi(modelId, modelNameHint) === DEFAULT_GPT5_API
    ? buildFoundryResponsesBaseUrl(endpoint)
    : buildAzureBaseUrl(endpoint, modelId);
}

export function extractFoundryEndpoint(baseUrl: string): string | undefined {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return undefined;
  }
}

export function buildFoundryModelCompat(
  modelId: string,
  modelNameHint?: string | null,
): FoundryModelCompat | undefined {
  if (!isGpt5FamilyDeployment(modelId, modelNameHint)) {
    return undefined;
  }
  return {
    maxTokensField: "max_completion_tokens" as const,
  };
}

export function resolveConfiguredModelNameHint(
  modelId: string,
  modelNameHint?: string | null,
): string | undefined {
  const trimmedName = typeof modelNameHint === "string" ? modelNameHint.trim() : "";
  if (trimmedName) {
    return trimmedName;
  }
  const trimmedId = modelId.trim();
  return trimmedId ? trimmedId : undefined;
}

export function buildFoundryProviderConfig(
  endpoint: string,
  modelId: string,
  modelNameHint?: string | null,
): ModelProviderConfig {
  const compat = buildFoundryModelCompat(modelId, modelNameHint);
  return {
    baseUrl: buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint),
    api: resolveFoundryApi(modelId, modelNameHint),
    models: [
      {
        id: modelId,
        name:
          typeof modelNameHint === "string" && modelNameHint.trim().length > 0
            ? modelNameHint.trim()
            : modelId,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 16_384,
        ...(compat ? { compat } : {}),
      },
    ],
  };
}

export function normalizeEndpointOrigin(rawUrl: string | null | undefined): string | undefined {
  if (!rawUrl) {
    return undefined;
  }
  try {
    return new URL(rawUrl).origin;
  } catch {
    return undefined;
  }
}

function buildFoundryCredentialMetadata(params: {
  authMethod: "api-key" | "entra-id";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
}): Record<string, string> {
  const metadata: Record<string, string> = {
    authMethod: params.authMethod,
    endpoint: params.endpoint,
    modelId: params.modelId,
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

export function buildFoundryAuthResult(params: {
  profileId: string;
  apiKey: SecretInput;
  secretInputMode?: "plaintext" | "ref";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  authMethod: "api-key" | "entra-id";
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  notes?: string[];
}): ProviderAuthResult {
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
            subscriptionId: params.subscriptionId,
            subscriptionName: params.subscriptionName,
            tenantId: params.tenantId,
          }),
          params.secretInputMode ? { secretInputMode: params.secretInputMode } : undefined,
        ),
      },
    ],
    configPatch: {
      models: {
        providers: {
          [PROVIDER_ID]: buildFoundryProviderConfig(
            params.endpoint,
            params.modelId,
            params.modelNameHint,
          ),
        },
      },
    },
    defaultModel: `${PROVIDER_ID}/${params.modelId}`,
    notes: params.notes,
  };
}

export function applyFoundryProfileBinding(
  config: FoundryConfigShape,
  profileId: string,
): void {
  applyAuthProfileConfig(config, {
    profileId,
    provider: PROVIDER_ID,
    mode: "api_key",
  });
}

export function applyFoundryProviderConfig(
  config: FoundryConfigShape,
  providerConfig: ModelProviderConfig,
): void {
  config.models ??= {};
  config.models.providers ??= {};
  config.models.providers[PROVIDER_ID] = providerConfig;
}

export function resolveFoundryTargetProfileId(
  config: FoundryConfigShape,
  agentDir?: string,
): string | undefined {
  const configuredProfiles = config.auth?.profiles ?? {};
  const configuredProfileEntries = Object.entries(configuredProfiles).filter(([, profile]) => {
    return profile.provider === PROVIDER_ID;
  });
  if (configuredProfileEntries.length === 0) {
    return undefined;
  }
  const configuredProfileId =
    config.auth?.order?.[PROVIDER_ID]?.find((profileId) => profileId.trim().length > 0) ??
    (configuredProfileEntries.length === 1 ? configuredProfileEntries[0]?.[0] : undefined);
  if (!configuredProfileId || !agentDir) {
    return configuredProfileId;
  }
  const authStore = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const credential = authStore.profiles[configuredProfileId];
  const authMethod = credential?.type === "api_key" ? credential.metadata?.authMethod : undefined;
  if (authMethod === "api-key" || authMethod === "entra-id") {
    return configuredProfileId;
  }
  return configuredProfileId;
}
