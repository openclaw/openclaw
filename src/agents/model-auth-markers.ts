/**
 * Non-secret model-auth marker helpers.
 * Distinguishes persisted auth markers, env-var placeholders, OAuth markers,
 * local auth sentinels, and secret-ref header markers without exposing secrets.
 */
import {
  normalizeTrimmedStringList,
  uniqueStrings,
} from "@openclaw/normalization-core/string-normalization";
import type { ModelProviderConfig } from "../config/types.models.js";
import type { Model, ModelRequestHeaders } from "../llm/types.js";
import {
  listKnownProviderAuthEnvVarNamesRuntime as listKnownProviderEnvApiKeyNames,
  listOpenClawPluginManifestMetadataRuntime as listOpenClawPluginManifestMetadata,
} from "../plugins/plugin-metadata-snapshot-required.js";
import { NON_ENV_SECRETREF_MARKER } from "../secrets/provider-credential-values.js";
import type { ResolvedProviderAuth } from "./model-auth-runtime-shared.js";

/** @deprecated MiniMax provider-owned marker; do not use from third-party plugins. */
export const MINIMAX_OAUTH_MARKER = "minimax-oauth";
/** Prefix for persisted OAuth-backed API-key marker values. */
const OAUTH_API_KEY_MARKER_PREFIX = "oauth:";
/** Marker for local Ollama auth that does not use a real API key. */
const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
/** @deprecated Bundled local-provider marker; do not use from third-party plugins. */
export const CUSTOM_LOCAL_AUTH_MARKER = "custom-local";
/** @deprecated Codex provider-owned marker; do not use from third-party plugins. */
export const CODEX_APP_SERVER_AUTH_MARKER = "codex-app-server";
/** Marker for Google Vertex credentials resolved outside plain API-key env vars. */
export const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
/** Prefix for secret-ref header markers that name an env-backed source. */
export const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:"; // pragma: allowlist secret

const AWS_SDK_ENV_MARKERS = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
]);
const CORE_NON_SECRET_API_KEY_MARKERS = [
  CUSTOM_LOCAL_AUTH_MARKER,
  CODEX_APP_SERVER_AUTH_MARKER,
  GCP_VERTEX_CREDENTIALS_MARKER,
  OLLAMA_LOCAL_AUTH_MARKER,
  NON_ENV_SECRETREF_MARKER,
] as const;
let knownEnvApiKeyMarkersCache: Set<string> | undefined;
let knownNonSecretApiKeyMarkersCache: string[] | undefined;

// Legacy marker names kept for backward compatibility with existing models.json files.
const LEGACY_ENV_API_KEY_MARKERS = [
  "GOOGLE_API_KEY",
  "DEEPSEEK_API_KEY",
  "PERPLEXITY_API_KEY",
  "FIREWORKS_API_KEY",
  "NOVITA_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "AZURE_API_KEY",
  "MINIMAX_CODE_PLAN_KEY",
];

function listKnownEnvApiKeyMarkers(): Set<string> {
  knownEnvApiKeyMarkersCache ??= new Set([
    ...listKnownProviderEnvApiKeyNames(),
    ...LEGACY_ENV_API_KEY_MARKERS,
    ...AWS_SDK_ENV_MARKERS,
  ]);
  return knownEnvApiKeyMarkersCache;
}

/** List non-secret auth markers known from core and bundled plugin manifests. */
function listKnownNonSecretApiKeyMarkers(): readonly string[] {
  knownNonSecretApiKeyMarkersCache ??= uniqueStrings([
    ...CORE_NON_SECRET_API_KEY_MARKERS,
    ...listOpenClawPluginManifestMetadata().flatMap((plugin) =>
      plugin.origin === "bundled"
        ? normalizeTrimmedStringList(plugin.manifest.nonSecretAuthMarkers)
        : [],
    ),
  ]);
  return knownNonSecretApiKeyMarkersCache;
}

/** Return true for AWS SDK env marker values that represent ambient auth. */
function isAwsSdkAuthMarker(value: string): boolean {
  return AWS_SDK_ENV_MARKERS.has(value.trim());
}

/** Return true for recognized env-var API-key placeholders, excluding AWS SDK markers. */
export function isKnownEnvApiKeyMarker(value: string): boolean {
  const trimmed = value.trim();
  return listKnownEnvApiKeyMarkers().has(trimmed) && !isAwsSdkAuthMarker(trimmed);
}

/** Build the persisted OAuth marker for one provider id. */
export function resolveOAuthApiKeyMarker(providerId: string): string {
  return `${OAUTH_API_KEY_MARKER_PREFIX}${providerId.trim()}`;
}

/** Return true when a marker value points at provider OAuth auth. */
export function isOAuthApiKeyMarker(value: string): boolean {
  return value.trim().startsWith(OAUTH_API_KEY_MARKER_PREFIX);
}

/** Resolve the header-value placeholder for an env-backed secret-ref source. */
export function resolveEnvSecretRefHeaderValueMarker(envVarName: string): string {
  return `${SECRETREF_ENV_HEADER_MARKER_PREFIX}${envVarName.trim()}`;
}

/** Return true for secret-ref placeholders used in auth header values. */
export function isSecretRefHeaderValueMarker(value: string): boolean {
  const trimmed = value.trim();
  return (
    trimmed === NON_ENV_SECRETREF_MARKER || trimmed.startsWith(SECRETREF_ENV_HEADER_MARKER_PREFIX)
  );
}

/** Return true for persisted non-secret placeholders that should not be treated as real keys. */
export function isNonSecretApiKeyMarker(
  value: string,
  opts?: { includeEnvVarName?: boolean },
): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }
  const isKnownMarker =
    isOAuthApiKeyMarker(trimmed) ||
    listKnownNonSecretApiKeyMarkers().includes(trimmed) ||
    isAwsSdkAuthMarker(trimmed) ||
    isSecretRefHeaderValueMarker(trimmed);
  if (isKnownMarker) {
    return true;
  }
  if (opts?.includeEnvVarName === false) {
    return false;
  }
  // Do not treat arbitrary ALL_CAPS values as markers; only recognize the
  // known env-var markers we intentionally persist for compatibility.
  return listKnownEnvApiKeyMarkers().has(trimmed);
}

/** Explicit no-auth is terminal before any credential lookup or plugin preparation. */
export function resolveExplicitProviderNoAuth(params: {
  provider: string;
  providerConfig?: Pick<ModelProviderConfig, "auth" | "api">;
  modelApi?: string;
}): ResolvedProviderAuth | null {
  if (params.providerConfig?.auth !== "none") {
    return null;
  }
  if ((params.modelApi ?? params.providerConfig.api) !== "openai-completions") {
    throw new Error(
      `Provider "${params.provider}" with auth: "none" requires the openai-completions adapter. Select that adapter or configure an API key.`,
    );
  }
  return {
    apiKey: CUSTOM_LOCAL_AUTH_MARKER,
    source: `models.providers.${params.provider} (synthetic local key)`,
    mode: "api-key",
  };
}

/** Clears auth after the caller has merged all headers for a no-auth request. */
export function applyLocalNoAuthHeaders(
  api: string,
  apiKey: string | undefined,
  headers: ModelRequestHeaders | undefined,
): ModelRequestHeaders | undefined {
  if (apiKey !== CUSTOM_LOCAL_AUTH_MARKER || api !== "openai-completions") {
    return headers;
  }
  // Null every spelling: SDK callers may merge these headers over the original model headers.
  const next: ModelRequestHeaders = {
    ...Object.fromEntries(
      Object.entries(headers ?? {}).map(([name, value]) => [
        name,
        name.toLowerCase() === "authorization" ? null : value,
      ]),
    ),
    Authorization: null,
  };
  return next;
}

/** Clears auth for OpenAI-compatible servers that explicitly use no auth. */
export function applyLocalNoAuthHeaderOverride<T extends Model>(
  model: T,
  auth: Pick<ResolvedProviderAuth, "apiKey"> | null | undefined,
): Omit<T, "headers"> & Pick<Model, "headers"> {
  const headers = applyLocalNoAuthHeaders(model.api, auth?.apiKey, model.headers);
  return headers === model.headers ? model : { ...model, headers };
}
