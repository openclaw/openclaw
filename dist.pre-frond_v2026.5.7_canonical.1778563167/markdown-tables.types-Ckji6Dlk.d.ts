import { i as OpenClawConfig } from "./types.openclaw-BdZr8Ncl.js";
import { S as MarkdownTableMode } from "./types.base-BUAA7yMj.js";

//#region src/config/markdown-tables.types.d.ts
type ResolveMarkdownTableModeParams = {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
};
type ResolveMarkdownTableMode = (params: ResolveMarkdownTableModeParams) => MarkdownTableMode;
//#endregion
export { ResolveMarkdownTableModeParams as n, ResolveMarkdownTableMode as t };