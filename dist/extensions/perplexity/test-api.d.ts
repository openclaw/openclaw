import { d as normalizeToIsoDate, l as isoToPerplexityDate } from "../../provider-web-search-DcNMGSex.js";

//#region extensions/perplexity/src/perplexity-web-search-provider.shared.d.ts
type PerplexityTransport = "search_api" | "chat_completions";
declare function inferPerplexityBaseUrlFromApiKey(apiKey?: string): "direct" | "openrouter" | undefined;
declare function isDirectPerplexityBaseUrl(baseUrl: string): boolean;
//#endregion
//#region extensions/perplexity/src/perplexity-web-search-provider.runtime.d.ts
type PerplexityConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
};
declare function resolvePerplexityApiKey(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
};
declare function resolvePerplexityBaseUrl(perplexity?: PerplexityConfig, authSource?: "config" | "perplexity_env" | "openrouter_env" | "none", configuredKey?: string): string;
declare function resolvePerplexityModel(perplexity?: PerplexityConfig): string;
declare function resolvePerplexityRequestModel(baseUrl: string, model: string): string;
declare function readPerplexityJsonResponse<T>(response: Response, label: string): Promise<T>;
declare function resolvePerplexityTransport(perplexity?: PerplexityConfig): {
  apiKey?: string;
  source: "config" | "perplexity_env" | "openrouter_env" | "none";
  baseUrl: string;
  model: string;
  transport: PerplexityTransport;
};
declare const testing: {
  readonly inferPerplexityBaseUrlFromApiKey: typeof inferPerplexityBaseUrlFromApiKey;
  readonly resolvePerplexityBaseUrl: typeof resolvePerplexityBaseUrl;
  readonly resolvePerplexityModel: typeof resolvePerplexityModel;
  readonly resolvePerplexityTransport: typeof resolvePerplexityTransport;
  readonly isDirectPerplexityBaseUrl: typeof isDirectPerplexityBaseUrl;
  readonly resolvePerplexityRequestModel: typeof resolvePerplexityRequestModel;
  readonly resolvePerplexityApiKey: typeof resolvePerplexityApiKey;
  readonly readPerplexityJsonResponse: typeof readPerplexityJsonResponse;
  readonly normalizeToIsoDate: typeof normalizeToIsoDate;
  readonly isoToPerplexityDate: typeof isoToPerplexityDate;
};
//#endregion
export { testing as __testing, testing };