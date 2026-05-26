import { i as OpenClawConfig } from "../types.openclaw-BLF4DJTX.js";
import { M as PluginWebFetchProviderEntry, R as WebFetchProviderToolDefinition } from "../types-core-DxqEkbXr.js";
import { t as RuntimeWebFetchMetadata } from "../runtime-web-tools.types-Co2KBj4w.js";
//#region src/web-fetch/runtime.d.ts
type WebFetchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web ? Web extends {
  fetch?: infer Fetch;
} ? Fetch : undefined : undefined;
type ResolveWebFetchDefinitionParams = {
  config?: OpenClawConfig;
  sandboxed?: boolean;
  runtimeWebFetch?: RuntimeWebFetchMetadata;
  providerId?: string;
  preferRuntimeProviders?: boolean;
};
declare function resolveWebFetchEnabled(params: {
  fetch?: WebFetchConfig;
  sandboxed?: boolean;
}): boolean;
declare function isWebFetchProviderConfigured(params: {
  provider: Pick<PluginWebFetchProviderEntry, "envVars" | "getConfiguredCredentialFallback" | "getConfiguredCredentialValue" | "getCredentialValue" | "requiresCredential">;
  config?: OpenClawConfig;
}): boolean;
declare function listWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[];
declare function listConfiguredWebFetchProviders(params?: {
  config?: OpenClawConfig;
}): PluginWebFetchProviderEntry[];
declare function resolveWebFetchProviderId(params: {
  fetch?: WebFetchConfig;
  config?: OpenClawConfig;
  providers?: PluginWebFetchProviderEntry[];
}): string;
declare function resolveWebFetchDefinition(options?: ResolveWebFetchDefinitionParams): {
  provider: PluginWebFetchProviderEntry;
  definition: WebFetchProviderToolDefinition;
} | null;
//#endregion
export { ResolveWebFetchDefinitionParams, isWebFetchProviderConfigured, listConfiguredWebFetchProviders, listWebFetchProviders, resolveWebFetchDefinition, resolveWebFetchEnabled, resolveWebFetchProviderId };