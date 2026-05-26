import { a as resolveProviderAuthEnvVarCandidates, n as listKnownProviderAuthEnvVarNames, o as resolveProviderAuthEvidence } from "./provider-env-vars-HpAfBQBJ.js";
import { t as listOpenClawPluginManifestMetadata } from "./manifest-metadata-scan-CK8TFnhN.js";
//#region src/agents/model-auth-env-vars.ts
function resolveProviderEnvApiKeyCandidates(params) {
	return resolveProviderAuthEnvVarCandidates(params);
}
function resolveProviderEnvAuthEvidence(params) {
	return resolveProviderAuthEvidence(params);
}
function listProviderEnvAuthLookupKeys(params) {
	return Array.from(new Set([...Object.keys(params.envCandidateMap), ...Object.keys(params.authEvidenceMap)])).toSorted((a, b) => a.localeCompare(b));
}
resolveProviderEnvApiKeyCandidates();
function listKnownProviderEnvApiKeyNames() {
	return listKnownProviderAuthEnvVarNames();
}
//#endregion
//#region src/agents/model-auth-markers.ts
/** @deprecated MiniMax provider-owned marker; do not use from third-party plugins. */
const MINIMAX_OAUTH_MARKER = "minimax-oauth";
const OAUTH_API_KEY_MARKER_PREFIX = "oauth:";
const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
/** @deprecated Bundled local-provider marker; do not use from third-party plugins. */
const CUSTOM_LOCAL_AUTH_MARKER = "custom-local";
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const NON_ENV_SECRETREF_MARKER = "secretref-managed";
const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:";
const AWS_SDK_ENV_MARKERS = new Set([
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_ACCESS_KEY_ID",
	"AWS_PROFILE"
]);
const CORE_NON_SECRET_API_KEY_MARKERS = [
	CUSTOM_LOCAL_AUTH_MARKER,
	OLLAMA_LOCAL_AUTH_MARKER,
	NON_ENV_SECRETREF_MARKER
];
let knownEnvApiKeyMarkersCache;
let knownNonSecretApiKeyMarkersCache;
const LEGACY_ENV_API_KEY_MARKERS = [
	"GOOGLE_API_KEY",
	"DEEPSEEK_API_KEY",
	"PERPLEXITY_API_KEY",
	"FIREWORKS_API_KEY",
	"NOVITA_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_API_KEY",
	"MINIMAX_CODE_PLAN_KEY"
];
function normalizeStringList(value) {
	if (!Array.isArray(value)) return [];
	return value.map((entry) => typeof entry === "string" ? entry.trim() : "").filter(Boolean);
}
function listKnownEnvApiKeyMarkers() {
	knownEnvApiKeyMarkersCache ??= new Set([
		...listKnownProviderEnvApiKeyNames(),
		...LEGACY_ENV_API_KEY_MARKERS,
		...AWS_SDK_ENV_MARKERS
	]);
	return knownEnvApiKeyMarkersCache;
}
function listKnownNonSecretApiKeyMarkers() {
	knownNonSecretApiKeyMarkersCache ??= [...new Set([...CORE_NON_SECRET_API_KEY_MARKERS, ...listOpenClawPluginManifestMetadata().flatMap((plugin) => plugin.origin === "bundled" ? normalizeStringList(plugin.manifest.nonSecretAuthMarkers) : [])])];
	return [...knownNonSecretApiKeyMarkersCache];
}
function isAwsSdkAuthMarker(value) {
	return AWS_SDK_ENV_MARKERS.has(value.trim());
}
function isKnownEnvApiKeyMarker(value) {
	const trimmed = value.trim();
	return listKnownEnvApiKeyMarkers().has(trimmed) && !isAwsSdkAuthMarker(trimmed);
}
function resolveOAuthApiKeyMarker(providerId) {
	return `${OAUTH_API_KEY_MARKER_PREFIX}${providerId.trim()}`;
}
function isOAuthApiKeyMarker(value) {
	return value.trim().startsWith(OAUTH_API_KEY_MARKER_PREFIX);
}
function resolveNonEnvSecretRefApiKeyMarker(_source) {
	return NON_ENV_SECRETREF_MARKER;
}
function resolveNonEnvSecretRefHeaderValueMarker(_source) {
	return NON_ENV_SECRETREF_MARKER;
}
function resolveEnvSecretRefHeaderValueMarker(envVarName) {
	return `${SECRETREF_ENV_HEADER_MARKER_PREFIX}${envVarName.trim()}`;
}
function isSecretRefHeaderValueMarker(value) {
	const trimmed = value.trim();
	return trimmed === "secretref-managed" || trimmed.startsWith("secretref-env:");
}
function isNonSecretApiKeyMarker(value, opts) {
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (isOAuthApiKeyMarker(trimmed) || listKnownNonSecretApiKeyMarkers().includes(trimmed) || isAwsSdkAuthMarker(trimmed)) return true;
	if (opts?.includeEnvVarName === false) return false;
	return listKnownEnvApiKeyMarkers().has(trimmed);
}
//#endregion
export { resolveOAuthApiKeyMarker as _, OAUTH_API_KEY_MARKER_PREFIX as a, resolveProviderEnvAuthEvidence as b, isAwsSdkAuthMarker as c, isOAuthApiKeyMarker as d, isSecretRefHeaderValueMarker as f, resolveNonEnvSecretRefHeaderValueMarker as g, resolveNonEnvSecretRefApiKeyMarker as h, NON_ENV_SECRETREF_MARKER as i, isKnownEnvApiKeyMarker as l, resolveEnvSecretRefHeaderValueMarker as m, GCP_VERTEX_CREDENTIALS_MARKER as n, OLLAMA_LOCAL_AUTH_MARKER as o, listKnownNonSecretApiKeyMarkers as p, MINIMAX_OAUTH_MARKER as r, SECRETREF_ENV_HEADER_MARKER_PREFIX as s, CUSTOM_LOCAL_AUTH_MARKER as t, isNonSecretApiKeyMarker as u, listProviderEnvAuthLookupKeys as v, resolveProviderEnvApiKeyCandidates as y };
