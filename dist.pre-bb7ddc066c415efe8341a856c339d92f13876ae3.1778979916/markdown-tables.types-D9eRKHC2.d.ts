import { i as OpenClawConfig } from "./types.openclaw-BuKAF4PW.js";
import { S as MarkdownTableMode } from "./types.base-BgiAX4pP.js";

//#region src/config/markdown-tables.types.d.ts
type ResolveMarkdownTableModeParams = {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
};
type ResolveMarkdownTableMode = (params: ResolveMarkdownTableModeParams) => MarkdownTableMode;
//#endregion
export { ResolveMarkdownTableModeParams as n, ResolveMarkdownTableMode as t };