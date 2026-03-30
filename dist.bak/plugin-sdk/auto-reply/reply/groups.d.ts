import type { OpenClawConfig } from "../../config/config.js";
import type { GroupKeyResolution, SessionEntry } from "../../config/sessions.js";
import type { TemplateContext } from "../templating.js";
export declare function resolveGroupRequireMention(params: {
    cfg: OpenClawConfig;
    ctx: TemplateContext;
    groupResolution?: GroupKeyResolution;
}): boolean;
export declare function defaultGroupActivation(requireMention: boolean): "always" | "mention";
/**
 * Build a persistent group-chat context block that is always included in the
 * system prompt for group-chat sessions (every turn, not just the first).
 *
 * Contains: group name, participants, and an explicit instruction to reply
 * directly instead of using the message tool.
 */
export declare function buildGroupChatContext(params: {
    sessionCtx: TemplateContext;
}): string;
export declare function buildGroupIntro(params: {
    cfg: OpenClawConfig;
    sessionCtx: TemplateContext;
    sessionEntry?: SessionEntry;
    defaultActivation: "always" | "mention";
    silentToken: string;
}): string;
