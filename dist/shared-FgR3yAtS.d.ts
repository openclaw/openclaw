import { kt as AuthConfig } from "./types.openclaw-BLF4DJTX.js";
import { l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { a as ModelApi, f as ModelProviderDeclarationConfig } from "./types.models-tqxsISRc.js";
import { At as ProviderAuthResult } from "./types-Vx7Jq4_-2.js";
//#region extensions/microsoft-foundry/shared.d.ts
declare const PROVIDER_ID = "microsoft-foundry";
declare const DEFAULT_API = "openai-completions";
declare const DEFAULT_GPT5_API = "openai-responses";
declare const COGNITIVE_SERVICES_RESOURCE = "https://cognitiveservices.azure.com";
declare const TOKEN_REFRESH_MARGIN_MS: number;
interface AzAccount {
  name: string;
  id: string;
  tenantId?: string;
  user?: {
    name?: string;
  };
  state?: string;
  isDefault?: boolean;
}
interface AzAccessToken {
  accessToken: string;
  expiresOn?: string;
}
interface AzCognitiveAccount {
  id: string;
  name: string;
  kind: string;
  location?: string;
  resourceGroup?: string;
  endpoint?: string | null;
  customSubdomain?: string | null;
  projects?: string[] | null;
}
interface FoundryResourceOption {
  id: string;
  accountName: string;
  kind: "AIServices" | "OpenAI";
  location?: string;
  resourceGroup: string;
  endpoint: string;
  projects: string[];
}
interface AzDeploymentSummary {
  name: string;
  modelName?: string;
  modelVersion?: string;
  state?: string;
  sku?: string;
}
type FoundrySelection = {
  endpoint: string;
  modelId: string;
  modelNameHint?: string;
  api: FoundryProviderApi;
};
type CachedTokenEntry = {
  token: string;
  expiresAt: number;
};
type FoundryProviderApi = typeof DEFAULT_API | typeof DEFAULT_GPT5_API;
type FoundryDeploymentConfigInput = {
  name: string;
  modelName?: string;
  api?: FoundryProviderApi;
};
type FoundryModelCapabilities = {
  modelName: string;
  api: FoundryProviderApi;
  input: Array<"text" | "image">;
  compat?: FoundryModelCompat;
};
type FoundryModelCompat = {
  supportsStore?: boolean;
  maxTokensField: "max_completion_tokens" | "max_tokens";
};
type FoundryConfigShape = {
  auth?: AuthConfig;
  models?: {
    providers?: Record<string, ModelProviderDeclarationConfig>;
  };
};
declare function usesFoundryResponsesByDefault(value?: string | null): boolean;
declare function supportsFoundryImageInput(value?: string | null): boolean;
declare function requiresFoundryMaxCompletionTokens(value?: string | null): boolean;
declare function isFoundryProviderApi(value?: string | null): value is FoundryProviderApi;
declare function normalizeFoundryEndpoint(endpoint: string): string;
declare function resolveFoundryApi(modelId: string, modelNameHint?: string | null, configuredApi?: ModelApi | null): FoundryProviderApi;
declare function buildFoundryProviderBaseUrl(endpoint: string, _modelId: string, _modelNameHint?: string | null, _configuredApi?: ModelApi | null): string;
declare function extractFoundryEndpoint(baseUrl: string | null | undefined): string | undefined;
declare function resolveFoundryModelCapabilities(modelId: string, modelNameHint?: string | null, configuredApi?: ModelApi | null, existingInput?: unknown): FoundryModelCapabilities;
declare function resolveConfiguredModelNameHint(modelId: string, modelNameHint?: string | null): string | undefined;
declare function listConfiguredFoundryProfileIds(config: FoundryConfigShape): string[];
declare function buildFoundryAuthResult(params: {
  profileId: string;
  apiKey: SecretInput;
  secretInputMode?: "plaintext" | "ref";
  endpoint: string;
  modelId: string;
  modelNameHint?: string | null;
  api: FoundryProviderApi;
  authMethod: "api-key" | "entra-id";
  subscriptionId?: string;
  subscriptionName?: string;
  tenantId?: string;
  notes?: string[]; /** Current plugins.allow so the provider can self-allowlist during onboard. */
  currentPluginsAllow?: string[];
  currentProviderProfileIds?: string[];
  deployments?: FoundryDeploymentConfigInput[];
}): ProviderAuthResult;
declare function applyFoundryProfileBinding(config: FoundryConfigShape, profileId: string): void;
declare function applyFoundryProviderConfig(config: FoundryConfigShape, providerConfig: ModelProviderDeclarationConfig): void;
declare function resolveFoundryTargetProfileId(config: FoundryConfigShape): string | undefined;
//#endregion
export { resolveConfiguredModelNameHint as C, supportsFoundryImageInput as D, resolveFoundryTargetProfileId as E, usesFoundryResponsesByDefault as O, requiresFoundryMaxCompletionTokens as S, resolveFoundryModelCapabilities as T, buildFoundryProviderBaseUrl as _, COGNITIVE_SERVICES_RESOURCE as a, listConfiguredFoundryProfileIds as b, DEFAULT_GPT5_API as c, FoundrySelection as d, PROVIDER_ID as f, buildFoundryAuthResult as g, applyFoundryProviderConfig as h, AzDeploymentSummary as i, FoundryProviderApi as l, applyFoundryProfileBinding as m, AzAccount as n, CachedTokenEntry as o, TOKEN_REFRESH_MARGIN_MS as p, AzCognitiveAccount as r, DEFAULT_API as s, AzAccessToken as t, FoundryResourceOption as u, extractFoundryEndpoint as v, resolveFoundryApi as w, normalizeFoundryEndpoint as x, isFoundryProviderApi as y };