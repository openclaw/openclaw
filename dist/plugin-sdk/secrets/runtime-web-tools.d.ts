import type { OpenClawConfig } from "../config/config.js";
import { type ResolverContext } from "./runtime-shared.js";
declare const WEB_SEARCH_PROVIDERS: readonly ["brave", "gemini", "grok", "kimi", "perplexity"];
type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];
type SecretResolutionSource = "config" | "secretRef" | "env" | "missing";
type RuntimeWebProviderSource = "configured" | "auto-detect" | "none";
export type RuntimeWebDiagnosticCode = "WEB_SEARCH_PROVIDER_INVALID_AUTODETECT" | "WEB_SEARCH_AUTODETECT_SELECTED" | "WEB_SEARCH_KEY_UNRESOLVED_FALLBACK_USED" | "WEB_SEARCH_KEY_UNRESOLVED_NO_FALLBACK" | "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_FALLBACK_USED" | "WEB_FETCH_FIRECRAWL_KEY_UNRESOLVED_NO_FALLBACK";
export type RuntimeWebDiagnostic = {
    code: RuntimeWebDiagnosticCode;
    message: string;
    path?: string;
};
export type RuntimeWebSearchMetadata = {
    providerConfigured?: WebSearchProvider;
    providerSource: RuntimeWebProviderSource;
    selectedProvider?: WebSearchProvider;
    selectedProviderKeySource?: SecretResolutionSource;
    perplexityTransport?: "search_api" | "chat_completions";
    diagnostics: RuntimeWebDiagnostic[];
};
export type RuntimeWebFetchFirecrawlMetadata = {
    active: boolean;
    apiKeySource: SecretResolutionSource;
    diagnostics: RuntimeWebDiagnostic[];
};
export type RuntimeWebToolsMetadata = {
    search: RuntimeWebSearchMetadata;
    fetch: {
        firecrawl: RuntimeWebFetchFirecrawlMetadata;
    };
    diagnostics: RuntimeWebDiagnostic[];
};
export declare function resolveRuntimeWebTools(params: {
    sourceConfig: OpenClawConfig;
    resolvedConfig: OpenClawConfig;
    context: ResolverContext;
}): Promise<RuntimeWebToolsMetadata>;
export {};
