//#region extensions/firecrawl/api.d.ts
type FetchFirecrawlContentParams = {
  url: string;
  extractMode: "markdown" | "text";
  apiKey: string;
  baseUrl: string;
  onlyMainContent: boolean;
  maxAgeMs: number;
  proxy: "auto" | "basic" | "stealth";
  storeInCache: boolean;
  timeoutSeconds: number;
  maxChars?: number;
};
type FetchFirecrawlContentResult = {
  text: string;
  title?: string;
  finalUrl?: string;
  status?: number;
  warning?: string;
};
declare function fetchFirecrawlContent(params: FetchFirecrawlContentParams): Promise<FetchFirecrawlContentResult>;
//#endregion
export { FetchFirecrawlContentParams, FetchFirecrawlContentResult, fetchFirecrawlContent };