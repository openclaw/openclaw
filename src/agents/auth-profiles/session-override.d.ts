import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
export declare function clearSessionAuthProfileOverride(params: {
    sessionEntry: SessionEntry;
    sessionStore: Record<string, SessionEntry>;
    sessionKey: string;
    storePath?: string;
}): Promise<void>;
export declare function resolveSessionAuthProfileOverride(params: {
    cfg: OpenClawConfig;
    provider: string;
    agentDir: string;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    isNewSession: boolean;
}): Promise<string | undefined>;
