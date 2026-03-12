import type { OpenClawConfig } from "../../config/config.js";
import type { MsgContext } from "../templating.js";
export declare const CURRENT_MESSAGE_MARKER = "[Current message - respond to this]";
export declare function buildMentionRegexes(cfg: OpenClawConfig | undefined, agentId?: string): RegExp[];
export declare function normalizeMentionText(text: string): string;
export declare function matchesMentionPatterns(text: string, mentionRegexes: RegExp[]): boolean;
export type ExplicitMentionSignal = {
    hasAnyMention: boolean;
    isExplicitlyMentioned: boolean;
    canResolveExplicit: boolean;
};
export declare function matchesMentionWithExplicit(params: {
    text: string;
    mentionRegexes: RegExp[];
    explicit?: ExplicitMentionSignal;
    transcript?: string;
}): boolean;
export declare function stripStructuralPrefixes(text: string): string;
export declare function stripMentions(text: string, ctx: MsgContext, cfg: OpenClawConfig | undefined, agentId?: string): string;
