import { type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SubagentRunOutcome } from "./subagent-announce-output.js";
import { type SubagentLifecycleEndedReason } from "./subagent-lifecycle-events.js";
export type SubagentSessionStoreCache = Map<string, Record<string, SessionEntry>>;
export type SubagentSessionCompletion = {
    endedAt: number;
    outcome: SubagentRunOutcome;
    reason: SubagentLifecycleEndedReason;
};
export declare function loadSubagentSessionEntry(params: {
    childSessionKey: string;
    storeCache?: SubagentSessionStoreCache;
    cfg?: OpenClawConfig;
}): SessionEntry | undefined;
export declare function resolveCompletionFromSessionEntry(sessionEntry: SessionEntry | undefined, fallbackEndedAt: number, opts?: {
    notBeforeMs?: number;
}): SubagentSessionCompletion | null;
export declare function resolveSubagentSessionCompletion(params: {
    childSessionKey: string;
    fallbackEndedAt: number;
    notBeforeMs?: number;
    storeCache?: SubagentSessionStoreCache;
    cfg?: OpenClawConfig;
}): SubagentSessionCompletion | null;
