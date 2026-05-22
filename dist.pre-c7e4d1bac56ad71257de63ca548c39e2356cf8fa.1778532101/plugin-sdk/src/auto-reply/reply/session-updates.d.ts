import { type SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export { drainFormattedSystemEvents } from "./session-system-events.js";
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
    cfg?: OpenClawConfig;
    now?: number;
    amount?: number;
    /** Token count after compaction - if provided, updates session token counts */
    tokensAfter?: number;
    /** Session id after compaction, when the runtime rotated transcripts. */
    newSessionId?: string;
    /** Session file after compaction, when the runtime rotated transcripts. */
    newSessionFile?: string;
}): Promise<number | undefined>;
