import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/config-runtime";
import {
  isKnownEnvApiKeyMarker,
  isNonSecretApiKeyMarker,
  normalizeApiKeyConfig,
  normalizeOptionalSecretInput,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER, LMSTUDIO_PROVIDER_ID } from "./defaults.js";

type LmstudioAuthHeadersParams = {
  apiKey?: string;
  json?: boolean;
  headers?: Record<string, string>;
};

export function buildLmstudioAuthHeaders(
  params: LmstudioAuthHeadersParams,
): Record<string, string> | undefined {
  const headers: Record<string, string> = { ...params.headers };
  // Keep auth optional because LM Studio can run without a token.
  const apiKey = params.apiKey?.trim();
  const isSyntheticLocalKey = apiKey === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
  if (apiKey && !isSyntheticLocalKey && !isNonSecretApiKeyMarker(apiKey)) {
    for (const headerName of Object.keys(headers)) {
      if (headerName.toLowerCase() === "authorization") {
        delete headers[headerName];
      }
    }
    headers.Authorization = `Bearer ${apiKey}`;
  }
  if (params.json) {
    headers["Content-Type"] = "application/json";
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function sanitizeStringHeaders(headers: unknown): Record<string, string> | undefined {
  if (!headers || typeof headers !== "object" || Array.isArray(headers)) {
    return undefined;
  }
  const next: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headers)) {
    if (typeof headerValue !== "string") {
      continue;
    }
    const normalized = headerValue.trim();
    if (!normalized) {
      continue;
    }
    next[headerName] = normalized;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export async function resolveLmstudioConfiguredApiKey(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  allowLocalFallback?: boolean;
  path?: string;
}): Promise<string | undefined> {
  const providerConfig = params.config?.models?.providers?.[LMSTUDIO_PROVIDER_ID];
  const apiKeyInput = providerConfig?.apiKey;
  const allowLocalFallback = params.allowLocalFallback === true;
  if (apiKeyInput === undefined || apiKeyInput === null) {
    return allowLocalFallback ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER : undefined;
  }

  const directApiKey = normalizeOptionalSecretInput(apiKeyInput);
  if (directApiKey !== undefined) {
    const trimmed = normalizeApiKeyConfig(directApiKey).trim();
    if (!trimmed) {
      return allowLocalFallback ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER : undefined;
    }
    if (trimmed === LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER) {
      return allowLocalFallback ? trimmed : undefined;
    }
    if (isKnownEnvApiKeyMarker(trimmed)) {
      const envValue = normalizeOptionalSecretInput((params.env ?? process.env)[trimmed]);
      return envValue ?? (allowLocalFallback ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER : undefined);
    }
    return isNonSecretApiKeyMarker(trimmed)
      ? allowLocalFallback
        ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER
        : undefined
      : trimmed;
  }

  if (!params.config) {
    return undefined;
  }
  const path = params.path ?? "models.providers.lmstudio.apiKey";
  const resolved = await resolveConfiguredSecretInputString({
    config: params.config,
    env: params.env ?? process.env,
    value: apiKeyInput,
    path,
    unresolvedReasonStyle: "detailed",
  });
  if (resolved.unresolvedRefReason) {
    throw new Error(`${path}: ${resolved.unresolvedRefReason}`);
  }
  const resolvedValue = normalizeOptionalSecretInput(resolved.value);
  if (resolvedValue) {
    return resolvedValue;
  }
  return allowLocalFallback ? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER : undefined;
}

export async function resolveLmstudioProviderHeaders(params: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  headers?: unknown;
  path?: string;
}): Promise<Record<string, string> | undefined> {
  const headerInputs = params.headers;
  if (!headerInputs || typeof headerInputs !== "object" || Array.isArray(headerInputs)) {
    return undefined;
  }

  if (!params.config) {
    return sanitizeStringHeaders(headerInputs);
  }

  const pathPrefix = params.path ?? "models.providers.lmstudio.headers";
  const resolved: Record<string, string> = {};
  for (const [headerName, headerValue] of Object.entries(headerInputs)) {
    const resolvedHeader = await resolveConfiguredSecretInputString({
      config: params.config,
      env: params.env ?? process.env,
      value: headerValue,
      path: `${pathPrefix}.${headerName}`,
      unresolvedReasonStyle: "detailed",
    });
    if (resolvedHeader.unresolvedRefReason) {
      throw new Error(`${pathPrefix}.${headerName}: ${resolvedHeader.unresolvedRefReason}`);
    }
    const resolvedValue = resolvedHeader.value;
    if (!resolvedValue) {
      continue;
    }
    resolved[headerName] = resolvedValue;
  }
  return Object.keys(resolved).length > 0 ? resolved : undefined;
}

/**
 * Resolves LM Studio API key and provider headers in parallel.
 * Use this as the standard auth setup step before discovery or model load calls.
 */
export async function resolveLmstudioRequestContext(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  providerHeaders?: unknown;
}): Promise<{ apiKey: string | undefined; headers: Record<string, string> | undefined }> {
  const [apiKey, headers] = await Promise.all([
    resolveLmstudioRuntimeApiKey({
      config: params.config,
      agentDir: params.agentDir,
      allowMissingAuth: true,
      env: params.env,
    }),
    resolveLmstudioProviderHeaders({
      config: params.config,
      env: params.env,
      headers: params.providerHeaders,
    }),
  ]);
  return { apiKey, headers };
}

/**
 * Resolves LM Studio runtime API key from config.
 */
export async function resolveLmstudioRuntimeApiKey(params: {
  config?: OpenClawConfig;
  agentDir?: string;
  allowMissingAuth?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<string | undefined> {
  const config = params.config;
  if (!config) {
    return undefined;
  }
  let configuredApiKeyPromise: Promise<string | undefined> | undefined;
  const getConfiguredApiKey = async () => {
    configuredApiKeyPromise ??= resolveLmstudioConfiguredApiKey({
      config,
      env: params.env,
      allowLocalFallback: true,
    });
    return await configuredApiKeyPromise;
  };
  let resolved: Awaited<ReturnType<typeof resolveApiKeyForProvider>>;
  try {
    resolved = await resolveApiKeyForProvider({
      provider: LMSTUDIO_PROVIDER_ID,
      cfg: config,
      agentDir: params.agentDir,
    });
  } catch (error) {
    const configuredApiKey = await getConfiguredApiKey();
    if (configuredApiKey) {
      return configuredApiKey;
    }
    if (params.allowMissingAuth) {
      return undefined;
    }
    throw error;
  }
  // Normalize empty/whitespace keys to undefined for callers.
  const resolvedApiKey = resolved.apiKey?.trim();
  if (!resolvedApiKey || resolvedApiKey.length === 0) {
    return (await getConfiguredApiKey()) ?? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
  }
  if (isNonSecretApiKeyMarker(resolvedApiKey)) {
    return (await getConfiguredApiKey()) ?? LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER;
  }
  return resolvedApiKey;
}
