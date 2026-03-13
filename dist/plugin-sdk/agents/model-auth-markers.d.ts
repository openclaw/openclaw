import type { SecretRefSource } from "../config/types.secrets.js";
export declare const MINIMAX_OAUTH_MARKER = "minimax-oauth";
export declare const QWEN_OAUTH_MARKER = "qwen-oauth";
export declare const OLLAMA_LOCAL_AUTH_MARKER = "ollama-local";
export declare const NON_ENV_SECRETREF_MARKER = "secretref-managed";
export declare const SECRETREF_ENV_HEADER_MARKER_PREFIX = "secretref-env:";
export declare function isAwsSdkAuthMarker(value: string): boolean;
export declare function isKnownEnvApiKeyMarker(value: string): boolean;
export declare function resolveNonEnvSecretRefApiKeyMarker(_source: SecretRefSource): string;
export declare function resolveNonEnvSecretRefHeaderValueMarker(_source: SecretRefSource): string;
export declare function resolveEnvSecretRefHeaderValueMarker(envVarName: string): string;
export declare function isSecretRefHeaderValueMarker(value: string): boolean;
export declare function isNonSecretApiKeyMarker(value: string, opts?: {
    includeEnvVarName?: boolean;
}): boolean;
