import type { SessionEntry } from "../config/sessions.js";
export type SessionIdMatchSelection = {
    kind: "none";
} | {
    kind: "ambiguous";
    sessionKeys: string[];
} | {
    kind: "selected";
    sessionKey: string;
};
export declare function resolveSessionIdMatchSelection(matches: Array<[string, SessionEntry]>, sessionId: string): SessionIdMatchSelection;
export declare function resolvePreferredSessionKeyForSessionIdMatches(matches: Array<[string, SessionEntry]>, sessionId: string): string | undefined;
