//#region src/plugins/web-content-extractor-types.d.ts
type WebContentExtractMode = "markdown" | "text";
type WebContentExtractionRequest = {
  html: string;
  url: string;
  extractMode: WebContentExtractMode;
};
type WebContentExtractionResult = {
  text: string;
  title?: string;
};
type WebContentExtractorPlugin = {
  id: string;
  label: string;
  autoDetectOrder?: number;
  extract: (request: WebContentExtractionRequest) => Promise<WebContentExtractionResult | null>;
};
//#endregion
//#region src/agents/tools/web-fetch-visibility.d.ts
declare function sanitizeHtml(html: string): Promise<string>;
declare function stripInvisibleUnicode(text: string): string;
//#endregion
export { WebContentExtractionResult as a, WebContentExtractionRequest as i, stripInvisibleUnicode as n, WebContentExtractorPlugin as o, WebContentExtractMode as r, sanitizeHtml as t };