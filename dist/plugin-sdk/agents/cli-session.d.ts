import type { SessionEntry } from "../config/sessions.js";
export declare function getCliSessionId(entry: SessionEntry | undefined, provider: string): string | undefined;
export declare function setCliSessionId(entry: SessionEntry, provider: string, sessionId: string): void;
