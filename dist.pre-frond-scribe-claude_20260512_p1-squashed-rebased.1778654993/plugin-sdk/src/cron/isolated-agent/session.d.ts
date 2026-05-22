import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function resolveCronSession(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    nowMs: number;
    agentId: string;
    forceNew?: boolean;
    store?: Record<string, SessionEntry>;
}): {
    storePath: string;
    store: Record<string, SessionEntry>;
    sessionEntry: SessionEntry;
    systemSent: boolean;
    isNewSession: boolean;
    previousSessionId: string | undefined;
};
