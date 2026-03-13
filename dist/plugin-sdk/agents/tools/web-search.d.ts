import type { OpenClawConfig } from "../../config/config.js";
import type { RuntimeWebSearchMetadata } from "../../secrets/runtime-web-tools.js";
import type { AnyAgentTool } from "./common.js";
import { resolveCitationRedirectUrl } from "./web-search-citation-redirect.js";
import { CacheEntry } from "./web-shared.js";
declare const SEARCH_PROVIDERS: readonly ["brave", "gemini", "grok", "kimi", "perplexity"];
declare function isoToPerplexityDate(iso: string): string | undefined;
declare function normalizeToIsoDate(value: string): string | undefined;
type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web ? Web extends {
    search?: infer Search;
} ? Search : undefined : undefined;
type BraveLlmContextResult = {
    url: string;
    title: string;
    snippets: string[];
};
type BraveLlmContextResponse = {
    grounding: {
        generic?: BraveLlmContextResult[];
    };
    sources?: {
        url?: string;
        hostname?: string;
        date?: string;
    }[];
};
type BraveConfig = {
    mode?: string;
};
type PerplexityConfig = {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
};
type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";
type PerplexityTransport = "search_api" | "chat_completions";
type PerplexityBaseUrlHint = "direct" | "openrouter";
type GrokConfig = {
    apiKey?: string;
    model?: string;
    inlineCitations?: boolean;
};
type KimiConfig = {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
};
type GrokSearchResponse = {
    output?: Array<{
        type?: string;
        role?: string;
        text?: string;
        content?: Array<{
            type?: string;
            text?: string;
            annotations?: Array<{
                type?: string;
                url?: string;
                start_index?: number;
                end_index?: number;
            }>;
        }>;
        annotations?: Array<{
            type?: string;
            url?: string;
            start_index?: number;
            end_index?: number;
        }>;
    }>;
    output_text?: string;
    citations?: string[];
    inline_citations?: Array<{
        start_index: number;
        end_index: number;
        url: string;
    }>;
};
type KimiToolCall = {
    id?: string;
    type?: string;
    function?: {
        name?: string;
        arguments?: string;
    };
};
type KimiMessage = {
    role?: string;
    content?: string;
    reasoning_content?: string;
    tool_calls?: KimiToolCall[];
};
type KimiSearchResponse = {
    choices?: Array<{
        finish_reason?: string;
        message?: KimiMessage;
    }>;
    search_results?: Array<{
        title?: string;
        url?: string;
        content?: string;
    }>;
};
declare function extractGrokContent(data: GrokSearchResponse): {
    text: string | undefined;
    annotationCitations: string[];
};
declare function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number];
declare function resolveBraveMode(brave: BraveConfig): "web" | "llm-context";
declare function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
    apiKey?: string;
    source: PerplexityApiKeySource;
};
declare function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined;
declare function resolvePerplexityBaseUrl(perplexity?: PerplexityConfig, authSource?: PerplexityApiKeySource, // pragma: allowlist secret
configuredKey?: string): string;
declare function resolvePerplexityModel(perplexity?: PerplexityConfig): string;
declare function isDirectPerplexityBaseUrl(baseUrl: string): boolean;
declare function resolvePerplexityRequestModel(baseUrl: string, model: string): string;
declare function resolvePerplexityTransport(perplexity?: PerplexityConfig): {
    apiKey?: string;
    source: PerplexityApiKeySource;
    baseUrl: string;
    model: string;
    transport: PerplexityTransport;
};
declare function resolveGrokApiKey(grok?: GrokConfig): string | undefined;
declare function resolveGrokModel(grok?: GrokConfig): string;
declare function resolveGrokInlineCitations(grok?: GrokConfig): boolean;
declare function resolveKimiApiKey(kimi?: KimiConfig): string | undefined;
declare function resolveKimiModel(kimi?: KimiConfig): string;
declare function resolveKimiBaseUrl(kimi?: KimiConfig): string;
declare function normalizeBraveLanguageParams(params: {
    search_lang?: string;
    ui_lang?: string;
}): {
    search_lang?: string;
    ui_lang?: string;
    invalidField?: "search_lang" | "ui_lang";
};
/**
 * Normalizes freshness shortcut to the provider's expected format.
 * Accepts both Brave format (pd/pw/pm/py) and Perplexity format (day/week/month/year).
 * For Brave, also accepts date ranges (YYYY-MM-DDtoYYYY-MM-DD).
 */
declare function normalizeFreshness(value: string | undefined, provider: (typeof SEARCH_PROVIDERS)[number]): string | undefined;
declare function extractKimiCitations(data: KimiSearchResponse): string[];
declare function mapBraveLlmContextResults(data: BraveLlmContextResponse): {
    url: string;
    title: string;
    snippets: string[];
    siteName?: string;
}[];
export declare function createWebSearchTool(options?: {
    config?: OpenClawConfig;
    sandboxed?: boolean;
    runtimeWebSearch?: RuntimeWebSearchMetadata;
}): AnyAgentTool | null;
export declare const __testing: {
    readonly resolveSearchProvider: typeof resolveSearchProvider;
    readonly inferPerplexityBaseUrlFromApiKey: typeof inferPerplexityBaseUrlFromApiKey;
    readonly resolvePerplexityBaseUrl: typeof resolvePerplexityBaseUrl;
    readonly resolvePerplexityModel: typeof resolvePerplexityModel;
    readonly resolvePerplexityTransport: typeof resolvePerplexityTransport;
    readonly isDirectPerplexityBaseUrl: typeof isDirectPerplexityBaseUrl;
    readonly resolvePerplexityRequestModel: typeof resolvePerplexityRequestModel;
    readonly resolvePerplexityApiKey: typeof resolvePerplexityApiKey;
    readonly normalizeBraveLanguageParams: typeof normalizeBraveLanguageParams;
    readonly normalizeFreshness: typeof normalizeFreshness;
    readonly normalizeToIsoDate: typeof normalizeToIsoDate;
    readonly isoToPerplexityDate: typeof isoToPerplexityDate;
    readonly SEARCH_CACHE: Map<string, CacheEntry<Record<string, unknown>>>;
    readonly FRESHNESS_TO_RECENCY: Record<string, string>;
    readonly RECENCY_TO_FRESHNESS: Record<string, string>;
    readonly resolveGrokApiKey: typeof resolveGrokApiKey;
    readonly resolveGrokModel: typeof resolveGrokModel;
    readonly resolveGrokInlineCitations: typeof resolveGrokInlineCitations;
    readonly extractGrokContent: typeof extractGrokContent;
    readonly resolveKimiApiKey: typeof resolveKimiApiKey;
    readonly resolveKimiModel: typeof resolveKimiModel;
    readonly resolveKimiBaseUrl: typeof resolveKimiBaseUrl;
    readonly extractKimiCitations: typeof extractKimiCitations;
    readonly resolveRedirectUrl: typeof resolveCitationRedirectUrl;
    readonly resolveBraveMode: typeof resolveBraveMode;
    readonly mapBraveLlmContextResults: typeof mapBraveLlmContextResults;
};
export {};
