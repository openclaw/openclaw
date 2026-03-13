import type { OpenClawConfig } from "../../config/config.js";
import { type SessionEntry } from "../../config/sessions.js";
export declare function resolveParentForkMaxTokens(cfg: OpenClawConfig): number;
export declare function forkSessionFromParent(params: {
    parentEntry: SessionEntry;
    agentId: string;
    sessionsDir: string;
}): {
    sessionId: string;
    sessionFile: string;
} | null;
