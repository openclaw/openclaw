import { GenerativeAiClient } from "oci-generativeai";
import { ensureAuthProfileStore } from "openclaw/plugin-sdk/agent-runtime";
import type {
  ProviderCatalogContext,
  ProviderPrepareRuntimeAuthContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  DEFAULT_CONTEXT_TOKENS,
  normalizeModelCompat,
  type ModelDefinitionConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { logWarn } from "openclaw/plugin-sdk/text-runtime";
import {
  createOracleAuthenticationDetailsProvider,
  buildOracleRuntimeAuthToken,
  ORACLE_MISSING_CONFIG_FILE_ERROR,
  ORACLE_PROFILE_ID,
  ORACLE_PROVIDER_ID,
  resolveOracleAuth,
} from "./oci-auth.js";
import { isOracleCatalogModelVisible } from "./oci-routing.js";

const ORACLE_BASE_URL = "oci://generative-ai";

type OracleModelSummary = {
  id?: string;
  displayName?: string;
  vendor?: string;
  version?: string;
  lifecycleState?: string;
  type?: string;
  capabilities?: string[];
};

type OracleListModelsResponse = {
  opcNextPage?: string;
  modelCollection?: {
    items?: OracleModelSummary[];
  };
};

type OracleCatalogProvider = {
  baseUrl: string;
  api: "openai-completions";
  apiKey: string;
  models: ModelDefinitionConfig[];
};

function trimToUndefined(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeOracleVendorToken(vendor: unknown): string | undefined {
  const trimmed = trimToUndefined(vendor);
  if (!trimmed) {
    return undefined;
  }
  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || undefined;
}

function isOracleFriendlyModelName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.trim());
}

function buildOracleOnDemandModelRef(model: OracleModelSummary): string | undefined {
  const displayName = trimToUndefined(model.displayName);
  if (!displayName || !isOracleFriendlyModelName(displayName)) {
    return undefined;
  }

  const normalizedDisplayName = displayName.toLowerCase();
  const vendorToken = normalizeOracleVendorToken(model.vendor);
  if (!vendorToken) {
    return normalizedDisplayName;
  }
  if (
    normalizedDisplayName.startsWith(`${vendorToken}.`) ||
    normalizedDisplayName.startsWith(`${vendorToken}-`)
  ) {
    return normalizedDisplayName;
  }
  return `${vendorToken}.${normalizedDisplayName}`;
}

function appendOracleModelVersion(name: string, version: string | undefined): string {
  const trimmedVersion = trimToUndefined(version);
  if (!trimmedVersion) {
    return name;
  }
  return name.toLowerCase().includes(trimmedVersion.toLowerCase())
    ? name
    : `${name} ${trimmedVersion}`;
}

export function buildOracleCatalogModelId(model: OracleModelSummary): string {
  // Oracle ON_DEMAND requests accept the model name as modelId. Prefer that
  // stable, vendor-qualified ref when available so downstream family detection
  // can recognize models even when OCI's raw ids are opaque ocid1 values.
  return buildOracleOnDemandModelRef(model) ?? trimToUndefined(model.id) ?? "";
}

function buildOracleModelName(model: OracleModelSummary): string {
  const catalogModelId = buildOracleCatalogModelId(model);
  const rawId = trimToUndefined(model.id);
  if (catalogModelId && catalogModelId !== rawId) {
    return appendOracleModelVersion(catalogModelId, model.version);
  }

  const displayName = trimToUndefined(model.displayName);
  if (displayName) {
    return appendOracleModelVersion(displayName, model.version);
  }
  const fallback = [
    trimToUndefined(model.vendor),
    trimToUndefined(model.version),
    trimToUndefined(model.id),
  ]
    .filter(Boolean)
    .join(" ");
  return fallback || "Oracle model";
}

export function buildOracleModelDefinition(modelId: string, name = modelId): ModelDefinitionConfig {
  return {
    id: modelId,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_TOKENS,
    maxTokens: DEFAULT_CONTEXT_TOKENS,
  };
}

function buildOracleRuntimeModel(modelId: string, name = modelId): ProviderRuntimeModel {
  const definition = buildOracleModelDefinition(modelId, name);
  return normalizeModelCompat({
    ...definition,
    api: "openai-completions",
    provider: ORACLE_PROVIDER_ID,
    baseUrl: ORACLE_BASE_URL,
  } as ProviderRuntimeModel);
}

export function buildOracleCatalogModelDefinition(
  model: OracleModelSummary,
): ModelDefinitionConfig {
  return buildOracleModelDefinition(buildOracleCatalogModelId(model), buildOracleModelName(model));
}

function isOracleChatBaseModel(model: OracleModelSummary): boolean {
  return (
    trimToUndefined(model.id) !== undefined &&
    model.lifecycleState === "ACTIVE" &&
    model.type === "BASE" &&
    Array.isArray(model.capabilities) &&
    model.capabilities.includes("CHAT")
  );
}

function shouldIncludeOracleCatalogModel(model: OracleModelSummary): boolean {
  return (
    isOracleChatBaseModel(model) && isOracleCatalogModelVisible(buildOracleCatalogModelId(model))
  );
}

function loadOracleProfileMetadata(
  agentDir?: string,
  profileId = ORACLE_PROFILE_ID,
): Record<string, string> {
  const store = ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const profile = store.profiles[profileId];
  return profile?.type === "api_key" ? (profile.metadata ?? {}) : {};
}

function buildStoredOracleAuthOverrides(params: { agentDir?: string; profileId?: string }): {
  agentDir?: string;
  profileId?: string;
  profile?: string;
  compartmentId?: string;
} {
  const profileId = trimToUndefined(params.profileId);
  if (!profileId) {
    return {};
  }

  const storedMetadata = loadOracleProfileMetadata(params.agentDir, profileId);
  return {
    agentDir: params.agentDir,
    profileId,
    profile: storedMetadata.profile,
    compartmentId: storedMetadata.compartmentId,
  };
}

async function listOracleModels(configFile: string, profile: string, compartmentId: string) {
  const authenticationDetailsProvider = createOracleAuthenticationDetailsProvider({
    configFile,
    profile,
  });
  const client = new GenerativeAiClient({ authenticationDetailsProvider });
  try {
    const models: OracleModelSummary[] = [];
    let page: string | undefined;

    do {
      const response = (await client.listModels({
        compartmentId,
        ...(page ? { page } : {}),
      })) as OracleListModelsResponse;
      models.push(...(response.modelCollection?.items ?? []));
      page = trimToUndefined(response.opcNextPage);
    } while (page);

    return models;
  } finally {
    try {
      client.close();
    } catch {
      // Best-effort cleanup only.
    }
  }
}

function handleOracleCatalogDiscoveryError(error: unknown): null | undefined {
  if (!(error instanceof Error)) {
    return undefined;
  }
  if (error.message === ORACLE_MISSING_CONFIG_FILE_ERROR) {
    return null;
  }

  const message = error.message.trim() || "unknown error";
  logWarn(`oracle: catalog discovery failed, skipping provider: ${message}`);
  return null;
}

export async function resolveOracleCatalogProvider(
  ctx: ProviderCatalogContext,
): Promise<{ provider: OracleCatalogProvider } | null> {
  const resolvedAuth = ctx.resolveProviderAuth(ORACLE_PROVIDER_ID);
  const storedAuthOverrides =
    resolvedAuth.source === "profile"
      ? buildStoredOracleAuthOverrides({
          agentDir: ctx.agentDir,
          profileId: resolvedAuth.profileId,
        })
      : {};
  let auth;
  try {
    auth = resolveOracleAuth({
      env: ctx.env,
      // Provider discovery should resolve the real OCI config path, not the
      // env/profile marker string used for runtime/provider selection.
      configFile: resolvedAuth.discoveryApiKey,
      ...storedAuthOverrides,
    });
  } catch (error) {
    const handled = handleOracleCatalogDiscoveryError(error);
    if (handled === null) {
      return handled;
    }
    throw error;
  }

  let models;
  try {
    models = (await listOracleModels(auth.configFile, auth.profile, auth.compartmentId))
      .filter((model) => shouldIncludeOracleCatalogModel(model))
      .map((model) => buildOracleCatalogModelDefinition(model))
      .toSorted((left, right) => left.name.localeCompare(right.name));
  } catch (error) {
    const handled = handleOracleCatalogDiscoveryError(error);
    if (handled === null) {
      return handled;
    }
    throw error;
  }

  if (models.length === 0) {
    return null;
  }

  return {
    provider: {
      baseUrl: ORACLE_BASE_URL,
      api: "openai-completions",
      apiKey: auth.configFile,
      models,
    },
  };
}

export function resolveOracleDynamicModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const modelId = ctx.modelId.trim();
  return modelId ? buildOracleRuntimeModel(modelId) : undefined;
}

export async function prepareOracleRuntimeAuth(ctx: ProviderPrepareRuntimeAuthContext) {
  const storedAuthOverrides = buildStoredOracleAuthOverrides({
    agentDir: ctx.agentDir,
    profileId: ctx.profileId,
  });
  const auth = resolveOracleAuth({
    env: ctx.env,
    configFile: ctx.apiKey,
    ...storedAuthOverrides,
  });

  return {
    apiKey: buildOracleRuntimeAuthToken(auth),
  };
}
