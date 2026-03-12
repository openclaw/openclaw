import type { loadConfig } from "../../config/config.js";
import type { WebInboundMsg } from "./types.js";
export type MentionConfig = {
    mentionRegexes: RegExp[];
    allowFrom?: Array<string | number>;
};
export type MentionTargets = {
    normalizedMentions: string[];
    selfE164: string | null;
    selfJid: string | null;
};
export declare function buildMentionConfig(cfg: ReturnType<typeof loadConfig>, agentId?: string): MentionConfig;
export declare function resolveMentionTargets(msg: WebInboundMsg, authDir?: string): MentionTargets;
export declare function isBotMentionedFromTargets(msg: WebInboundMsg, mentionCfg: MentionConfig, targets: MentionTargets): boolean;
export declare function debugMention(msg: WebInboundMsg, mentionCfg: MentionConfig, authDir?: string): {
    wasMentioned: boolean;
    details: Record<string, unknown>;
};
export declare function resolveOwnerList(mentionCfg: MentionConfig, selfE164?: string | null): string[];
