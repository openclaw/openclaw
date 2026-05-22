import { t as WebMediaResult } from "./web-media-CnY09WN8.js";
import { t as OutboundMediaAccess } from "./load-options-BLfH2vG_.js";
//#region src/plugin-sdk/outbound-media.d.ts
type OutboundMediaLoadOptions = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
};
/** Load outbound media from a remote URL or approved local path using the shared web-media policy. */
declare function loadOutboundMediaFromUrl(mediaUrl: string, options?: OutboundMediaLoadOptions): Promise<WebMediaResult>;
//#endregion
export { loadOutboundMediaFromUrl as n, OutboundMediaLoadOptions as t };