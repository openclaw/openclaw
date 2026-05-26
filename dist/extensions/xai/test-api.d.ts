//#region extensions/xai/src/web-search-response.types.d.ts
type XaiWebSearchResponse = {
  output?: Array<{
    type?: string;
    text?: string;
    content?: Array<{
      type?: string;
      text?: string;
      annotations?: Array<{
        type?: string;
        url?: string;
      } | null>;
    } | null>;
    annotations?: Array<{
      type?: string;
      url?: string;
    } | null>;
  } | null>;
  output_text?: string;
  citations?: string[];
  inline_citations?: Array<{
    start_index: number;
    end_index: number;
    url: string;
  }>;
};
//#endregion
//#region extensions/xai/src/responses-tool-shared.d.ts
declare function extractXaiWebSearchContent(data: XaiWebSearchResponse): {
  text: string | undefined;
  annotationCitations: string[];
};
//#endregion
//#region extensions/xai/src/web-search-shared.d.ts
type XaiWebSearchResult = {
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
};
declare function buildXaiWebSearchPayload(params: {
  query: string;
  provider: string;
  model: string;
  tookMs: number;
  content: string;
  citations: string[];
  inlineCitations?: XaiWebSearchResponse["inline_citations"];
}): Record<string, unknown>;
declare function resolveXaiWebSearchModel(searchConfig?: Record<string, unknown>): string;
declare function resolveXaiWebSearchEndpoint(searchConfig?: Record<string, unknown>): string;
declare function resolveXaiInlineCitations(searchConfig?: Record<string, unknown>): boolean;
declare function requestXaiWebSearch(params: {
  query: string;
  model: string;
  apiKey: string;
  endpoint: string;
  timeoutSeconds: number;
  inlineCitations: boolean;
}): Promise<XaiWebSearchResult>;
//#endregion
//#region extensions/xai/src/web-search-provider.runtime.d.ts
declare function resolveXaiToolSearchConfig(ctx: {
  config?: Record<string, unknown>;
  searchConfig?: Record<string, unknown>;
}): Record<string, unknown> | undefined;
declare function resolveXaiWebSearchCredential(searchConfig?: Record<string, unknown>): string | undefined;
type XaiResolvedWebSearchAuth = {
  apiKey: string;
  mode?: "api-key" | "oauth" | "token" | "aws-sdk";
  profileId?: string;
};
declare function resolveXaiWebSearchAuth(ctx: {
  config?: Record<string, unknown>;
  agentDir?: string;
}, searchConfig?: Record<string, unknown>, options?: {
  forceRefresh?: boolean;
  profileId?: string;
}): Promise<XaiResolvedWebSearchAuth | undefined>;
declare function resolveXaiWebSearchTimeoutSeconds(searchConfig?: Record<string, unknown>): number;
declare const testing: {
  buildXaiWebSearchPayload: typeof buildXaiWebSearchPayload;
  extractXaiWebSearchContent: typeof extractXaiWebSearchContent;
  resolveXaiToolSearchConfig: typeof resolveXaiToolSearchConfig;
  resolveXaiWebSearchAuth: typeof resolveXaiWebSearchAuth;
  resolveXaiInlineCitations: typeof resolveXaiInlineCitations;
  resolveXaiWebSearchCredential: typeof resolveXaiWebSearchCredential;
  resolveXaiWebSearchEndpoint: typeof resolveXaiWebSearchEndpoint;
  resolveXaiWebSearchModel: typeof resolveXaiWebSearchModel;
  resolveXaiWebSearchTimeoutSeconds: typeof resolveXaiWebSearchTimeoutSeconds;
  requestXaiWebSearch: typeof requestXaiWebSearch;
};
//#endregion
export { testing as __testing, testing };