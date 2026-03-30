import { type ThinkLevel, type VerboseLevel } from "../../auto-reply/thinking.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
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
