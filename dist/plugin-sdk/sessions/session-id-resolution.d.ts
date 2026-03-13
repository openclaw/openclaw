import type { SessionEntry } from "../config/sessions.js";
export declare function resolvePreferredSessionKeyForSessionIdMatches(matches: Array<[string, SessionEntry]>, sessionId: string): string | undefined;
