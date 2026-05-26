import { type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { errorShape } from "./protocol/index.js";
import { type ArchivedSessionTranscript } from "./session-transcript-files.fs.js";
import { resolveGatewaySessionStoreTarget } from "./session-utils.js";
export declare function archiveSessionTranscriptsForSession(params: {
    sessionId: string | undefined;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
    reason: "reset" | "deleted";
    onArchiveError?: (err: unknown, sourcePath: string) => void;
}): string[];
export declare function archiveSessionTranscriptsForSessionDetailed(params: {
    sessionId: string | undefined;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
    reason: "reset" | "deleted";
    onArchiveError?: (err: unknown, sourcePath: string) => void;
}): ArchivedSessionTranscript[];
export declare function emitGatewaySessionEndPluginHook(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId?: string;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
    reason: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "shutdown" | "restart" | "unknown";
    archivedTranscripts?: ArchivedSessionTranscript[];
    nextSessionId?: string;
    nextSessionKey?: string;
}): void;
export declare function emitGatewaySessionStartPluginHook(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId?: string;
    resumedFrom?: string;
    storePath?: string;
    sessionFile?: string;
    agentId?: string;
}): void;
export type DrainActiveSessionsForShutdownResult = {
    emittedSessionIds: string[];
    timedOut: boolean;
};
/**
 * Emit a typed `session_end` for every session that received `session_start`
 * but did not yet receive a paired `session_end`. The bounded total timeout
 * mirrors the gateway lifecycle hook timeout so a slow plugin cannot block
 * SIGTERM/SIGINT past the runtime's overall shutdown grace window.
 *
 * Sessions that have already been finalized through replace / reset / delete /
 * compaction are forgotten from the tracker by `emitGatewaySessionEndPluginHook`
 * before this drain runs, so they will not be double-fired here.
 */
export declare function drainActiveSessionsForShutdown(params: {
    reason: "shutdown" | "restart";
    totalTimeoutMs?: number;
}): Promise<DrainActiveSessionsForShutdownResult>;
export declare function emitSessionUnboundLifecycleEvent(params: {
    targetSessionKey: string;
    reason: "session-reset" | "session-delete";
    emitHooks?: boolean;
}): Promise<void>;
export declare function cleanupSessionBeforeMutation(params: {
    cfg: OpenClawConfig;
    key: string;
    target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
    entry: SessionEntry | undefined;
    legacyKey?: string;
    canonicalKey?: string;
    reason: "session-reset" | "session-delete";
}): Promise<{
    code: string;
    message: string;
    details?: unknown;
    retryable?: boolean | undefined;
    retryAfterMs?: number | undefined;
} | undefined>;
export declare function emitGatewayBeforeResetPluginHook(params: {
    cfg: OpenClawConfig;
    key: string;
    target: ReturnType<typeof resolveGatewaySessionStoreTarget>;
    storePath: string;
    entry?: SessionEntry;
    reason: "new" | "reset";
}): Promise<void>;
export declare function performGatewaySessionReset(params: {
    key: string;
    reason: "new" | "reset";
    commandSource: string;
}): Promise<{
    ok: true;
    key: string;
    entry: SessionEntry;
} | {
    ok: false;
    error: ReturnType<typeof errorShape>;
}>;
