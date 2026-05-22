import { i as OpenClawConfig } from "./types.openclaw-Bpxi7OSY.js";
import { S as MarkdownTableMode } from "./types.base-B1xU9TH3.js";

//#region src/config/markdown-tables.types.d.ts
type ResolveMarkdownTableModeParams = {
  cfg?: Partial<OpenClawConfig>;
  channel?: string | null;
  accountId?: string | null;
};
type ResolveMarkdownTableMode = (params: ResolveMarkdownTableModeParams) => MarkdownTableMode;
//#endregion
export { ResolveMarkdownTableModeParams as n, ResolveMarkdownTableMode as t };