import WebSocket from "ws";

//#region extensions/browser/src/browser/cdp.helpers.d.ts
declare function parseBrowserHttpUrl(raw: string, label: string): {
  parsed: URL;
  port: number;
  hasExplicitPort: boolean;
  normalized: string;
  normalizedWithPort: string;
};
declare function redactCdpUrl(cdpUrl: string | null | undefined): string | null | undefined;
//#endregion
export { redactCdpUrl as n, parseBrowserHttpUrl as t };