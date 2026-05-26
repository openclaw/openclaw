import type { SessionEntry } from "../../config/sessions/types.js";
import type { MsgContext } from "../templating.js";
export type AbortCutoff = {
    messageSid?: string;
    timestamp?: number;
};
type SessionAbortCutoffEntry = Pick<SessionEntry, "abortCutoffMessageSid" | "abortCutoffTimestamp">;
export declare function resolveAbortCutoffFromContext(ctx: MsgContext): AbortCutoff | undefined;
export declare function readAbortCutoffFromSessionEntry(entry: SessionAbortCutoffEntry | undefined): AbortCutoff | undefined;
export declare function hasAbortCutoff(entry: SessionAbortCutoffEntry | undefined): boolean;
export declare function applyAbortCutoffToSessionEntry(entry: SessionAbortCutoffEntry, cutoff: AbortCutoff | undefined): void;
export declare function shouldSkipMessageByAbortCutoff(params: {
    cutoffMessageSid?: string;
    cutoffTimestamp?: number;
    messageSid?: string;
    timestamp?: number;
}): boolean;
export declare function shouldPersistAbortCutoff(params: {
    commandSessionKey?: string;
    targetSessionKey?: string;
}): boolean;
export {};
