//#region src/terminal/links.d.ts
declare function formatDocsLink(path: string | undefined | null, label?: string, opts?: {
  fallback?: string;
  force?: boolean;
}): string;
//#endregion
export { formatDocsLink as t };