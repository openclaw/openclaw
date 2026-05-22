//#region extensions/brave/src/brave-web-search-provider.shared.d.ts
type BraveConfig = {
  baseUrl?: unknown;
  mode?: string;
};
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
declare function normalizeBraveCountry(value: string | undefined): string | undefined;
declare function resolveBraveMode(brave?: BraveConfig): "web" | "llm-context";
declare function normalizeBraveLanguageParams(params: {
  search_lang?: string;
  ui_lang?: string;
}): {
  search_lang?: string;
  ui_lang?: string;
  invalidField?: "search_lang" | "ui_lang";
};
declare function mapBraveLlmContextResults(data: BraveLlmContextResponse): {
  url: string;
  title: string;
  snippets: string[];
  siteName?: string;
}[];
//#endregion
//#region extensions/brave/test-api.d.ts
declare const __testing: {
  readonly normalizeBraveCountry: typeof normalizeBraveCountry;
  readonly normalizeBraveLanguageParams: typeof normalizeBraveLanguageParams;
  readonly resolveBraveMode: typeof resolveBraveMode;
  readonly mapBraveLlmContextResults: typeof mapBraveLlmContextResults;
};
//#endregion
export { __testing };