import type { SessionEntry } from "../../config/sessions.js";
export declare function applySessionHints(params: {
    baseBody: string;
    abortedLastRun: boolean;
    sessionEntry?: SessionEntry;
    sessionStore?: Record<string, SessionEntry>;
    sessionKey?: string;
    storePath?: string;
    abortKey?: string;
}): Promise<string>;
