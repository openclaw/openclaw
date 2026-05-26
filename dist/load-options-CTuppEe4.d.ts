//#region src/media/load-options.d.ts
type OutboundMediaReadFile = (filePath: string) => Promise<Buffer>;
type OutboundMediaAccess = {
  localRoots?: readonly string[];
  readFile?: OutboundMediaReadFile; /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};
type OutboundMediaLoadParams = {
  maxBytes?: number;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[] | "any";
  mediaReadFile?: OutboundMediaReadFile;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
  optimizeImages?: boolean; /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};
type OutboundMediaLoadOptions = {
  maxBytes?: number;
  localRoots?: readonly string[] | "any";
  readFile?: (filePath: string) => Promise<Buffer>;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  trustExplicitProxyDns?: boolean;
  hostReadCapability?: boolean;
  optimizeImages?: boolean; /** Agent workspace directory for resolving relative MEDIA: paths. */
  workspaceDir?: string;
};
declare function resolveOutboundMediaLocalRoots(mediaLocalRoots?: readonly string[] | "any"): readonly string[] | "any" | undefined;
declare function resolveOutboundMediaAccess(params?: {
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: OutboundMediaReadFile;
}): OutboundMediaAccess | undefined;
declare function buildOutboundMediaLoadOptions(params?: OutboundMediaLoadParams): OutboundMediaLoadOptions;
//#endregion
export { buildOutboundMediaLoadOptions as a, OutboundMediaReadFile as i, OutboundMediaLoadOptions as n, resolveOutboundMediaAccess as o, OutboundMediaLoadParams as r, resolveOutboundMediaLocalRoots as s, OutboundMediaAccess as t };