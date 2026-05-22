import { m as SecretRefSource } from "./types.secrets-tbFW-hY6.js";

//#region src/agents/model-auth-markers.d.ts
/** @deprecated MiniMax provider-owned marker; do not use from third-party plugins. */
declare const MINIMAX_OAUTH_MARKER = "minimax-oauth";
declare const OAUTH_API_KEY_MARKER_PREFIX = "oauth:";
declare const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
/** @deprecated Bundled local-provider marker; do not use from third-party plugins. */
declare const CUSTOM_LOCAL_AUTH_MARKER = "custom-local";
declare const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
declare const NON_ENV_SECRETREF_MARKER = "secretref-managed";
declare const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:";
declare function listKnownNonSecretApiKeyMarkers(): string[];
declare function isAwsSdkAuthMarker(value: string): boolean;
declare function isKnownEnvApiKeyMarker(value: string): boolean;
declare function resolveOAuthApiKeyMarker(providerId: string): string;
declare function isOAuthApiKeyMarker(value: string): boolean;
declare function resolveNonEnvSecretRefApiKeyMarker(_source: SecretRefSource): string;
declare function resolveNonEnvSecretRefHeaderValueMarker(_source: SecretRefSource): string;
declare function resolveEnvSecretRefHeaderValueMarker(envVarName: string): string;
declare function isSecretRefHeaderValueMarker(value: string): boolean;
declare function isNonSecretApiKeyMarker(value: string, opts?: {
  includeEnvVarName?: boolean;
}): boolean;
//#endregion
export { resolveOAuthApiKeyMarker as _, OAUTH_API_KEY_MARKER_PREFIX as a, isAwsSdkAuthMarker as c, isOAuthApiKeyMarker as d, isSecretRefHeaderValueMarker as f, resolveNonEnvSecretRefHeaderValueMarker as g, resolveNonEnvSecretRefApiKeyMarker as h, NON_ENV_SECRETREF_MARKER as i, isKnownEnvApiKeyMarker as l, resolveEnvSecretRefHeaderValueMarker as m, GCP_VERTEX_CREDENTIALS_MARKER as n, OLLAMA_LOCAL_AUTH_MARKER as o, listKnownNonSecretApiKeyMarkers as p, MINIMAX_OAUTH_MARKER as r, SECRETREF_ENV_HEADER_MARKER_PREFIX as s, CUSTOM_LOCAL_AUTH_MARKER as t, isNonSecretApiKeyMarker as u };