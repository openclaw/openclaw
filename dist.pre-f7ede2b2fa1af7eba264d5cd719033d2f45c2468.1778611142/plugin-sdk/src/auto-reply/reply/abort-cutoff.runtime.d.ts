import type { SessionEntry } from "../../config/sessions/types.js";
export declare function clearAbortCutoffInSessionRuntime(params: {
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
}): Promise<boolean>;
