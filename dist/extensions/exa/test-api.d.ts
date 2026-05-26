import { o as SearchConfigRecord } from "../../provider-web-search-DcNMGSex.js";

//#region extensions/exa/src/exa-web-search-provider.runtime.d.ts
declare const EXA_SEARCH_TYPES: readonly ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"];
declare const EXA_FRESHNESS_VALUES: readonly ["day", "week", "month", "year"];
type ExaConfig = {
  apiKey?: string;
  baseUrl?: string;
};
type ExaSearchType = (typeof EXA_SEARCH_TYPES)[number];
type ExaFreshness = (typeof EXA_FRESHNESS_VALUES)[number];
type ExaTextContentsOption = boolean | {
  maxCharacters?: number;
};
type ExaHighlightsContentsOption = boolean | {
  maxCharacters?: number;
  query?: string;
  numSentences?: number;
  highlightsPerUrl?: number;
};
type ExaSummaryContentsOption = boolean | {
  query?: string;
};
type ExaContentsArgs = {
  highlights?: ExaHighlightsContentsOption;
  text?: ExaTextContentsOption;
  summary?: ExaSummaryContentsOption;
};
type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  highlightScores?: unknown;
  summary?: unknown;
  text?: unknown;
};
declare function readExaSearchResults(response: Response): Promise<ExaSearchResult[]>;
declare function normalizeExaFreshness(value: string | undefined): ExaFreshness | undefined;
declare function resolveExaConfig(searchConfig?: SearchConfigRecord): ExaConfig;
declare function resolveExaApiKey(exa?: ExaConfig): string | undefined;
declare function resolveExaSearchEndpoint(exa?: ExaConfig): {
  endpoint: string;
} | {
  error: string;
  message: string;
  docs: string;
};
declare function resolveExaDescription(result: ExaSearchResult): string;
declare function resolveExaSearchCount(value: unknown, fallback: number): number;
declare function parseExaContents(rawContents: unknown): {
  value?: ExaContentsArgs;
} | {
  error: string;
  message: string;
  docs: string;
};
declare function normalizeExaResults(payload: unknown): ExaSearchResult[];
declare function resolveFreshnessStartDate(freshness: ExaFreshness): string;
declare function buildExaCacheKey(params: {
  endpoint: string;
  type: ExaSearchType;
  query: string;
  count: number;
  freshness?: ExaFreshness;
  dateAfter?: string;
  dateBefore?: string;
  contents?: ExaContentsArgs;
}): string;
declare const testing: {
  readonly normalizeExaResults: typeof normalizeExaResults;
  readonly normalizeExaFreshness: typeof normalizeExaFreshness;
  readonly parseExaContents: typeof parseExaContents;
  readonly buildExaCacheKey: typeof buildExaCacheKey;
  readonly resolveExaApiKey: typeof resolveExaApiKey;
  readonly resolveExaConfig: typeof resolveExaConfig;
  readonly resolveExaDescription: typeof resolveExaDescription;
  readonly resolveExaSearchCount: typeof resolveExaSearchCount;
  readonly resolveExaSearchEndpoint: typeof resolveExaSearchEndpoint;
  readonly resolveFreshnessStartDate: typeof resolveFreshnessStartDate;
  readonly readExaSearchResults: typeof readExaSearchResults;
};
//#endregion
export { testing as __testing, testing };