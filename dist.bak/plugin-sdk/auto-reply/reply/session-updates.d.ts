import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
export declare function prependSystemEvents(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    isMainSession: boolean;
    isNewSession: boolean;
    prefixedBodyBase: string;
}): Promise<string>;
export declare function ensureSkillSnapshot(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    sessionId?: string;
    isFirstTurnInSession: boolean;
    workspaceDir: string;
    cfg: OpenClawConfig;
    /** If provided, only load skills with these names (for per-channel skill filtering) */
    skillFilter?: string[];
}): Promise<{
    sessionEntry?: SessionEntry;
    skillsSnapshot?: SessionEntry["skillsSnapshot"];
    systemSent: boolean;
}>;
export declare function incrementCompactionCount(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    now?: number;
    /** Token count after compaction - if provided, updates session token counts */
    tokensAfter?: number;
}): Promise<number | undefined>;
