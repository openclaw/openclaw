import type { OpenClawConfig } from "./config.js";
import type { MarkdownTableMode } from "./types.base.js";
export declare function resolveMarkdownTableMode(params: {
    cfg?: Partial<OpenClawConfig>;
    channel?: string | null;
    accountId?: string | null;
}): MarkdownTableMode;
