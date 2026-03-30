import type { OpenClawConfig } from "../../config/config.js";
import type { AnyAgentTool } from "./common.js";
declare const SEARCH_PROVIDERS: readonly ["brave", "perplexity", "grok", "gemini", "kimi"];
type WebSearchConfig = NonNullable<OpenClawConfig["tools"]>["web"] extends infer Web ? Web extends {
    search?: infer Search;
} ? Search : undefined : undefined;
type PerplexityConfig = {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
};
type PerplexityApiKeySource = "config" | "perplexity_env" | "openrouter_env" | "none";
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
type PerplexityBaseUrlHint = "direct" | "openrouter";
declare function extractGrokContent(data: GrokSearchResponse): {
    text: string | undefined;
    annotationCitations: string[];
};
declare function resolveSearchProvider(search?: WebSearchConfig): (typeof SEARCH_PROVIDERS)[number];
declare function inferPerplexityBaseUrlFromApiKey(apiKey?: string): PerplexityBaseUrlHint | undefined;
declare function resolvePerplexityBaseUrl(perplexity?: PerplexityConfig, apiKeySource?: PerplexityApiKeySource, apiKey?: string): string;
declare function isDirectPerplexityBaseUrl(baseUrl: string): boolean;
declare function resolvePerplexityRequestModel(baseUrl: string, model: string): string;
declare function resolveGrokApiKey(grok?: GrokConfig): string | undefined;
declare function resolveGrokModel(grok?: GrokConfig): string;
declare function resolveGrokInlineCitations(grok?: GrokConfig): boolean;
declare function resolveKimiApiKey(kimi?: KimiConfig): string | undefined;
declare function resolveKimiModel(kimi?: KimiConfig): string;
declare function resolveKimiBaseUrl(kimi?: KimiConfig): string;
/**
 * Resolve a redirect URL to its final destination using a HEAD request.
 * Returns the original URL if resolution fails or times out.
 */
declare function resolveRedirectUrl(url: string): Promise<string>;
declare function normalizeBraveLanguageParams(params: {
    search_lang?: string;
    ui_lang?: string;
}): {
    search_lang?: string;
    ui_lang?: string;
    invalidField?: "search_lang" | "ui_lang";
};
declare function normalizeFreshness(value: string | undefined): string | undefined;
/**
 * Map normalized freshness values (pd/pw/pm/py) to Perplexity's
 * search_recency_filter values (day/week/month/year).
 */
declare function freshnessToPerplexityRecency(freshness: string | undefined): string | undefined;
declare function extractKimiCitations(data: KimiSearchResponse): string[];
export declare function createWebSearchTool(options?: {
    config?: OpenClawConfig;
    sandboxed?: boolean;
}): AnyAgentTool | null;
export declare const __testing: {
    readonly resolveSearchProvider: typeof resolveSearchProvider;
    readonly inferPerplexityBaseUrlFromApiKey: typeof inferPerplexityBaseUrlFromApiKey;
    readonly resolvePerplexityBaseUrl: typeof resolvePerplexityBaseUrl;
    readonly isDirectPerplexityBaseUrl: typeof isDirectPerplexityBaseUrl;
    readonly resolvePerplexityRequestModel: typeof resolvePerplexityRequestModel;
    readonly normalizeBraveLanguageParams: typeof normalizeBraveLanguageParams;
    readonly normalizeFreshness: typeof normalizeFreshness;
    readonly freshnessToPerplexityRecency: typeof freshnessToPerplexityRecency;
    readonly resolveGrokApiKey: typeof resolveGrokApiKey;
    readonly resolveGrokModel: typeof resolveGrokModel;
    readonly resolveGrokInlineCitations: typeof resolveGrokInlineCitations;
    readonly extractGrokContent: typeof extractGrokContent;
    readonly resolveKimiApiKey: typeof resolveKimiApiKey;
    readonly resolveKimiModel: typeof resolveKimiModel;
    readonly resolveKimiBaseUrl: typeof resolveKimiBaseUrl;
    readonly extractKimiCitations: typeof extractKimiCitations;
    readonly resolveRedirectUrl: typeof resolveRedirectUrl;
};
export {};
