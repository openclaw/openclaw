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
}): string[];
export declare function archiveSessionTranscriptsForSessionDetailed(params: {
    sessionId: string | undefined;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
    reason: "reset" | "deleted";
}): ArchivedSessionTranscript[];
export declare function emitGatewaySessionEndPluginHook(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId?: string;
    storePath: string;
    sessionFile?: string;
    agentId?: string;
    reason: "new" | "reset" | "idle" | "daily" | "compaction" | "deleted" | "unknown";
    archivedTranscripts?: ArchivedSessionTranscript[];
    nextSessionId?: string;
    nextSessionKey?: string;
}): void;
export declare function emitGatewaySessionStartPluginHook(params: {
    cfg: OpenClawConfig;
    sessionKey: string;
    sessionId?: string;
    resumedFrom?: string;
}): void;
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
