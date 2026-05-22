import { type ParsedThreadSessionSuffix } from "../../sessions/session-key-utils.js";
export type ResolvedSessionConversation = {
    id: string;
    threadId: string | undefined;
    baseConversationId: string;
    parentConversationCandidates: string[];
};
export type ResolvedSessionConversationRef = {
    channel: string;
    kind: "group" | "channel";
    rawId: string;
    id: string;
    threadId: string | undefined;
    baseSessionKey: string;
    baseConversationId: string;
    parentConversationCandidates: string[];
};
type SessionConversationResolutionOptions = {
    bundledFallback?: boolean;
};
export declare function resolveSessionConversation(params: {
    channel: string;
    kind: "group" | "channel";
    rawId: string;
    bundledFallback?: boolean;
}): ResolvedSessionConversation | null;
export declare function resolveSessionConversationRef(sessionKey: string | undefined | null, opts?: SessionConversationResolutionOptions): ResolvedSessionConversationRef | null;
export declare function resolveSessionThreadInfo(sessionKey: string | undefined | null, opts?: SessionConversationResolutionOptions): ParsedThreadSessionSuffix;
export declare function resolveSessionParentSessionKey(sessionKey: string | undefined | null): string | null;
export {};
