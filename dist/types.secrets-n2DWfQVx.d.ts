//#region src/config/types.secrets.d.ts
type SecretRefSource = "env" | "file" | "exec";
/**
 * Stable identifier for a secret in a configured source.
 * Examples:
 * - env source: provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 */
type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};
type SecretInput = string | SecretRef;
declare const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
declare const ENV_SECRET_REF_ID_RE: RegExp;
declare const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
declare const LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX = "__env__:";
type SecretInputStringResolutionMode = "strict" | "inspect";
type SecretInputStringResolution = {
  status: "available";
  value: string;
  ref: null;
} | {
  status: "configured_unavailable";
  value: undefined;
  ref: SecretRef;
} | {
  status: "missing";
  value: undefined;
  ref: null;
};
type SecretDefaults = {
  env?: string;
  file?: string;
  exec?: string;
};
declare function isValidEnvSecretRefId(value: string): boolean;
declare function isSecretRef(value: unknown): value is SecretRef;
declare function parseEnvTemplateSecretRef(value: unknown, provider?: string): SecretRef | null;
declare function parseLegacySecretRefEnvMarker(value: unknown, provider?: string): SecretRef | null;
declare function coerceSecretRef(value: unknown, defaults?: SecretDefaults): SecretRef | null;
declare function hasConfiguredSecretInput(value: unknown, defaults?: SecretDefaults): boolean;
declare function normalizeSecretInputString(value: unknown): string | undefined;
declare function assertSecretInputResolved(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): void;
declare function resolveSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
  mode?: SecretInputStringResolutionMode;
}): SecretInputStringResolution;
declare function normalizeResolvedSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): string | undefined;
declare function resolveSecretInputRef(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
}): {
  explicitRef: SecretRef | null;
  inlineRef: SecretRef | null;
  ref: SecretRef | null;
};
type EnvSecretProviderConfig = {
  source: "env"; /** Optional env var allowlist (exact names). */
  allowlist?: string[];
};
type FileSecretProviderMode = "singleValue" | "json";
type FileSecretProviderConfig = {
  source: "file";
  path: string;
  mode?: FileSecretProviderMode;
  timeoutMs?: number;
  maxBytes?: number;
  allowInsecurePath?: boolean;
};
type ExecSecretProviderConfig = {
  source: "exec";
  command: string;
  args?: string[];
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
  jsonOnly?: boolean;
  env?: Record<string, string>;
  passEnv?: string[];
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkCommand?: boolean;
};
type SecretProviderConfig = EnvSecretProviderConfig | FileSecretProviderConfig | ExecSecretProviderConfig;
type SecretsConfig = {
  providers?: Record<string, SecretProviderConfig>;
  defaults?: {
    env?: string;
    file?: string;
    exec?: string;
  };
  resolution?: {
    maxProviderConcurrency?: number;
    maxRefsPerProvider?: number;
    maxBatchBytes?: number;
  };
};
//#endregion
export { parseEnvTemplateSecretRef as C, resolveSecretInputString as E, normalizeSecretInputString as S, resolveSecretInputRef as T, coerceSecretRef as _, FileSecretProviderConfig as a, isValidEnvSecretRefId as b, LEGACY_SECRETREF_ENV_MARKER_PREFIX as c, SecretInputStringResolutionMode as d, SecretProviderConfig as f, assertSecretInputResolved as g, SecretsConfig as h, ExecSecretProviderConfig as i, SecretInput as l, SecretRefSource as m, ENV_SECRET_REF_ID_RE as n, FileSecretProviderMode as o, SecretRef as p, EnvSecretProviderConfig as r, LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX as s, DEFAULT_SECRET_PROVIDER_ALIAS as t, SecretInputStringResolution as u, hasConfiguredSecretInput as v, parseLegacySecretRefEnvMarker as w, normalizeResolvedSecretInputString as x, isSecretRef as y };