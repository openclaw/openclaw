import { type ThinkLevel, type VerboseLevel } from "../../auto-reply/thinking.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export type SessionResolution = {
    sessionId: string;
    sessionKey?: string;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    storePath: string;
    isNewSession: boolean;
    persistedThinking?: ThinkLevel;
    persistedVerbose?: VerboseLevel;
};
type SessionKeyResolution = {
    sessionKey?: string;
    sessionStore: Record<string, SessionEntry>;
    storePath: string;
};
export declare function buildExplicitSessionIdSessionKey(params: {
    sessionId: string;
    agentId?: string;
}): string;
/**
 * Resolve an existing stored session key for a session id from a specific agent store.
 * This scopes the lookup to the target store without implicitly converting `agentId`
 * into that agent's main session key.
 */
export declare function resolveStoredSessionKeyForSessionId(opts: {
    cfg: OpenClawConfig;
    sessionId: string;
    agentId?: string;
}): SessionKeyResolution;
export declare function resolveSessionKeyForRequest(opts: {
    cfg: OpenClawConfig;
    to?: string;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
}): SessionKeyResolution;
export declare function resolveSession(opts: {
    cfg: OpenClawConfig;
    to?: string;
    sessionId?: string;
    sessionKey?: string;
    agentId?: string;
}): SessionResolution;
export {};
