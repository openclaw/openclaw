import type { OpenClawConfig } from "../../config/types.openclaw.js";
export { isAnnounceSkip, isNonDeliverableSessionsReply, isReplySkip, } from "./sessions-send-tokens.js";
export type AnnounceTarget = {
    channel: string;
    to: string;
    accountId?: string;
    threadId?: string;
};
export declare function resolveAnnounceTargetFromKey(sessionKey: string): AnnounceTarget | null;
export declare function buildAgentToAgentMessageContext(params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
}): string;
export declare function buildAgentToAgentReplyContext(params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    currentRole: "requester" | "target";
    turn: number;
    maxTurns: number;
}): string;
export declare function buildAgentToAgentAnnounceContext(params: {
    requesterSessionKey?: string;
    requesterChannel?: string;
    targetSessionKey: string;
    targetChannel?: string;
    originalMessage: string;
    roundOneReply?: string;
    latestReply?: string;
}): string;
export declare function resolvePingPongTurns(cfg?: OpenClawConfig): number;
