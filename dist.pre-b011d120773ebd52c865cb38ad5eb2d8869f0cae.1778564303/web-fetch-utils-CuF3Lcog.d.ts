//#region src/agents/tools/web-fetch-utils.d.ts
type ExtractMode = "markdown" | "text";
declare function normalizeWhitespace(value: string): string;
declare function htmlToMarkdown(html: string): {
  text: string;
  title?: string;
};
declare function markdownToText(markdown: string): string;
declare function truncateText(value: string, maxChars: number): {
  text: string;
  truncated: boolean;
};
declare function extractBasicHtmlContent(params: {
  html: string;
  extractMode: ExtractMode;
}): Promise<{
  text: string;
  title?: string;
} | null>;
//#endregion
export { normalizeWhitespace as a, markdownToText as i, extractBasicHtmlContent as n, truncateText as o, htmlToMarkdown as r, ExtractMode as t };