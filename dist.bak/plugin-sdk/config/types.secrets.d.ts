export type SecretRefSource = "env" | "file" | "exec";
/**
 * Stable identifier for a secret in a configured source.
 * Examples:
 * - env source: provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 */
export type SecretRef = {
    source: SecretRefSource;
    provider: string;
    id: string;
};
export type SecretInput = string | SecretRef;
export declare const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
export declare function isSecretRef(value: unknown): value is SecretRef;
export declare function parseEnvTemplateSecretRef(value: unknown, provider?: string): SecretRef | null;
export declare function coerceSecretRef(value: unknown, defaults?: {
    env?: string;
    file?: string;
    exec?: string;
}): SecretRef | null;
export type EnvSecretProviderConfig = {
    source: "env";
    /** Optional env var allowlist (exact names). */
    allowlist?: string[];
};
export type FileSecretProviderMode = "singleValue" | "json";
export type FileSecretProviderConfig = {
    source: "file";
    path: string;
    mode?: FileSecretProviderMode;
    timeoutMs?: number;
    maxBytes?: number;
};
export type ExecSecretProviderConfig = {
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
export type SecretProviderConfig = EnvSecretProviderConfig | FileSecretProviderConfig | ExecSecretProviderConfig;
export type SecretsConfig = {
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
