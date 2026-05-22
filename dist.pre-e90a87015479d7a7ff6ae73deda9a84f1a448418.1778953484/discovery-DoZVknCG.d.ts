import { l as ModelProviderConfig, o as ModelDefinitionConfig } from "./types.models-DfLOOuHc.js";
//#region extensions/amazon-bedrock-mantle/discovery.d.ts
declare const MANTLE_IAM_TOKEN_MARKER = "__amazon_bedrock_mantle_iam__";
type MantleBearerTokenProvider = () => Promise<string>;
type MantleBearerTokenProviderFactory = (opts?: {
  region?: string;
  expiresInSeconds?: number;
}) => MantleBearerTokenProvider;
/**
 * Resolve a bearer token for Mantle authentication.
 *
 * Returns the value of AWS_BEARER_TOKEN_BEDROCK if set, undefined otherwise.
 * When no explicit token is set, `resolveImplicitMantleProvider` will attempt
 * to generate one from IAM credentials via `@aws/bedrock-token-generator`.
 */
declare function resolveMantleBearerToken(env?: NodeJS.ProcessEnv): string | undefined;
/**
 * Generate a bearer token from IAM credentials using `@aws/bedrock-token-generator`.
 *
 * Uses the AWS default credential chain (instance roles, SSO, access keys, EKS IRSA).
 * Returns undefined if the package is not installed or credentials are unavailable.
 */
declare function generateBearerTokenFromIam(params: {
  region: string;
  now?: () => number;
  tokenProviderFactory?: MantleBearerTokenProviderFactory;
}): Promise<string | undefined>;
/**
 * Read a cached IAM bearer token for the given region (sync, no generation).
 *
 * Returns the token if it exists and has not expired, undefined otherwise.
 * Used by Mantle runtime auth and tests to inspect the current cache.
 */
declare function getCachedIamToken(region: string): string | undefined;
declare function resolveMantleRuntimeBearerToken(params: {
  apiKey: string;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  tokenProviderFactory?: MantleBearerTokenProviderFactory;
}): Promise<{
  apiKey: string;
  expiresAt?: number;
} | undefined>;
/** Reset the IAM token cache (for testing). */
declare function resetIamTokenCacheForTest(): void;
type MantleDiscoveryConfig = {
  enabled?: boolean;
};
/** Clear the discovery cache (for testing). */
declare function resetMantleDiscoveryCacheForTest(): void;
/**
 * Discover available models from the Mantle `/v1/models` endpoint.
 *
 * The response is in standard OpenAI format:
 * ```json
 * { "data": [{ "id": "anthropic.claude-sonnet-4-6", "object": "model", "owned_by": "anthropic" }] }
 * ```
 *
 * Results are cached per region for `DEFAULT_REFRESH_INTERVAL_SECONDS`.
 * Returns an empty array if the request fails (no permission, network error, etc.).
 */
declare function discoverMantleModels(params: {
  region: string;
  bearerToken: string;
  fetchFn?: typeof fetch;
  now?: () => number;
}): Promise<ModelDefinitionConfig[]>;
/**
 * Resolve an implicit Bedrock Mantle provider if authentication is available.
 *
 * Detection priority:
 * 1. AWS_BEARER_TOKEN_BEDROCK env var → use directly
 * 2. IAM credentials → generate bearer token via `@aws/bedrock-token-generator`
 * - Region from AWS_REGION / AWS_DEFAULT_REGION / default us-east-1
 * - Models discovered from `/v1/models`
 */
declare function resolveImplicitMantleProvider(params: {
  env?: NodeJS.ProcessEnv;
  pluginConfig?: {
    discovery?: MantleDiscoveryConfig;
  };
  fetchFn?: typeof fetch;
  tokenProviderFactory?: MantleBearerTokenProviderFactory;
}): Promise<ModelProviderConfig | null>;
declare function mergeImplicitMantleProvider(params: {
  existing: ModelProviderConfig | undefined;
  implicit: ModelProviderConfig;
}): ModelProviderConfig;
//#endregion
export { mergeImplicitMantleProvider as a, resolveImplicitMantleProvider as c, getCachedIamToken as i, resolveMantleBearerToken as l, discoverMantleModels as n, resetIamTokenCacheForTest as o, generateBearerTokenFromIam as r, resetMantleDiscoveryCacheForTest as s, MANTLE_IAM_TOKEN_MARKER as t, resolveMantleRuntimeBearerToken as u };