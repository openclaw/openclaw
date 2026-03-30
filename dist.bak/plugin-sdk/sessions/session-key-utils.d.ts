export type ParsedAgentSessionKey = {
    agentId: string;
    rest: string;
};
export type SessionKeyChatType = "direct" | "group" | "channel" | "unknown";
/**
 * Parse agent-scoped session keys in a canonical, case-insensitive way.
 * Returned values are normalized to lowercase for stable comparisons/routing.
 */
export declare function parseAgentSessionKey(sessionKey: string | undefined | null): ParsedAgentSessionKey | null;
/**
 * Best-effort chat-type extraction from session keys across canonical and legacy formats.
 */
export declare function deriveSessionChatType(sessionKey: string | undefined | null): SessionKeyChatType;
export declare function isCronRunSessionKey(sessionKey: string | undefined | null): boolean;
export declare function isCronSessionKey(sessionKey: string | undefined | null): boolean;
export declare function isSubagentSessionKey(sessionKey: string | undefined | null): boolean;
export declare function getSubagentDepth(sessionKey: string | undefined | null): number;
export declare function isAcpSessionKey(sessionKey: string | undefined | null): boolean;
export declare function resolveThreadParentSessionKey(sessionKey: string | undefined | null): string | null;
