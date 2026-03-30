import type { ChatType } from "../channels/chat-type.js";
export { getSubagentDepth, isCronSessionKey, isAcpSessionKey, isSubagentSessionKey, parseAgentSessionKey, type ParsedAgentSessionKey, } from "../sessions/session-key-utils.js";
export { DEFAULT_ACCOUNT_ID, normalizeAccountId, normalizeOptionalAccountId, } from "./account-id.js";
export declare const DEFAULT_AGENT_ID = "main";
export declare const DEFAULT_MAIN_KEY = "main";
export type SessionKeyShape = "missing" | "agent" | "legacy_or_alias" | "malformed_agent";
export declare function normalizeMainKey(value: string | undefined | null): string;
export declare function toAgentRequestSessionKey(storeKey: string | undefined | null): string | undefined;
export declare function toAgentStoreSessionKey(params: {
    agentId: string;
    requestKey: string | undefined | null;
    mainKey?: string | undefined;
}): string;
export declare function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string;
export declare function classifySessionKeyShape(sessionKey: string | undefined | null): SessionKeyShape;
export declare function normalizeAgentId(value: string | undefined | null): string;
export declare function sanitizeAgentId(value: string | undefined | null): string;
export declare function buildAgentMainSessionKey(params: {
    agentId: string;
    mainKey?: string | undefined;
}): string;
export declare function buildAgentPeerSessionKey(params: {
    agentId: string;
    mainKey?: string | undefined;
    channel: string;
    accountId?: string | null;
    peerKind?: ChatType | null;
    peerId?: string | null;
    identityLinks?: Record<string, string[]>;
    /** DM session scope. */
    dmScope?: "main" | "per-peer" | "per-channel-peer" | "per-account-channel-peer";
}): string;
export declare function buildGroupHistoryKey(params: {
    channel: string;
    accountId?: string | null;
    peerKind: "group" | "channel";
    peerId: string;
}): string;
export declare function resolveThreadSessionKeys(params: {
    baseSessionKey: string;
    threadId?: string | null;
    parentSessionKey?: string;
    useSuffix?: boolean;
    normalizeThreadId?: (threadId: string) => string;
}): {
    sessionKey: string;
    parentSessionKey?: string;
};
