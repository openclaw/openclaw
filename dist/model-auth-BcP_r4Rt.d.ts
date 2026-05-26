import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { b as ResolvedProviderAuth } from "./types-core-DxqEkbXr.js";
import { s as AuthProfileStore } from "./types-BwDj5PsX.js";
import { t as EnvApiKeyLookupOptions } from "./model-auth-env-umi0uNrU.js";
import { Api, Model } from "@earendil-works/pi-ai";

//#region src/agents/model-auth.d.ts
type ProviderCredentialPrecedence = "profile-first" | "env-first";
type RuntimeProviderAuthLookup = {
  envApiKey: Pick<EnvApiKeyLookupOptions, "aliasMap" | "candidateMap" | "authEvidenceMap">;
  syntheticAuthProviderRefs?: readonly string[];
};
declare function createRuntimeProviderAuthLookup(params: {
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): RuntimeProviderAuthLookup;
declare function getCustomProviderApiKey(cfg: OpenClawConfig | undefined, provider: string): string | undefined;
type ResolvedCustomProviderApiKey = {
  apiKey: string;
  source: string;
};
declare function resolveUsableCustomProviderApiKey(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  env?: NodeJS.ProcessEnv;
}): ResolvedCustomProviderApiKey | null;
declare function hasUsableCustomProviderApiKey(cfg: OpenClawConfig | undefined, provider: string, env?: NodeJS.ProcessEnv): boolean;
declare function shouldPreferExplicitConfigApiKeyAuth(cfg: OpenClawConfig | undefined, provider: string): boolean;
declare function hasSyntheticLocalProviderAuthConfig(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): boolean;
declare function hasRuntimeAvailableProviderAuth(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  allowPluginSyntheticAuth?: boolean;
  runtimeLookup?: RuntimeProviderAuthLookup;
}): boolean;
declare function resolveApiKeyForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  /** When true, treat profileId as a user-locked selection that must not be
   *  silently overridden by env/config credentials. */
  lockedProfile?: boolean;
  forceRefresh?: boolean;
  credentialPrecedence?: ProviderCredentialPrecedence;
  modelApi?: string;
}): Promise<ResolvedProviderAuth>;
type ModelAuthMode = "api-key" | "oauth" | "token" | "mixed" | "aws-sdk" | "unknown";
declare function resolveModelAuthMode(provider?: string, cfg?: OpenClawConfig, store?: AuthProfileStore, options?: {
  workspaceDir?: string;
}): ModelAuthMode | undefined;
declare function hasAvailableAuthForProvider(params: {
  provider: string;
  cfg?: OpenClawConfig;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
}): Promise<boolean>;
declare function getApiKeyForModel(params: {
  model: Model<Api>;
  cfg?: OpenClawConfig;
  profileId?: string;
  preferredProfile?: string;
  store?: AuthProfileStore;
  agentDir?: string;
  workspaceDir?: string;
  lockedProfile?: boolean;
  credentialPrecedence?: ProviderCredentialPrecedence;
}): Promise<ResolvedProviderAuth>;
declare function applyLocalNoAuthHeaderOverride<T extends Model<Api>>(model: T, auth: ResolvedProviderAuth | null | undefined): T;
/**
 * When the provider config sets `authHeader: true`, inject an explicit
 * `Authorization: Bearer <apiKey>` header into the model so downstream SDKs
 * (e.g. `@google/genai`) send credentials via the standard HTTP Authorization
 * header instead of vendor-specific headers like `x-goog-api-key`.
 *
 * This is a no-op when `authHeader` is not `true`, when no API key is
 * available, or when the API key is a synthetic marker (e.g. local-server
 * placeholders) rather than a real credential.
 */
declare function applyAuthHeaderOverride<T extends Model<Api>>(model: T, auth: ResolvedProviderAuth | null | undefined, cfg: OpenClawConfig | undefined): T;
//#endregion
export { applyLocalNoAuthHeaderOverride as a, getCustomProviderApiKey as c, hasSyntheticLocalProviderAuthConfig as d, hasUsableCustomProviderApiKey as f, shouldPreferExplicitConfigApiKeyAuth as g, resolveUsableCustomProviderApiKey as h, applyAuthHeaderOverride as i, hasAvailableAuthForProvider as l, resolveModelAuthMode as m, ProviderCredentialPrecedence as n, createRuntimeProviderAuthLookup as o, resolveApiKeyForProvider as p, RuntimeProviderAuthLookup as r, getApiKeyForModel as s, ModelAuthMode as t, hasRuntimeAvailableProviderAuth as u };