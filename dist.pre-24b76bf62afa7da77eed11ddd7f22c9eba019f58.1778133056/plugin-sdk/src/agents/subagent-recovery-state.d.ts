import type { SessionEntry } from "../config/sessions.js";
type SubagentRecoveryGate = {
    allowed: true;
    nextAttempt: number;
} | {
    allowed: false;
    reason: string;
    shouldMarkWedged: boolean;
};
export declare function isSubagentRecoveryWedgedEntry(entry: unknown): boolean;
export declare function formatSubagentRecoveryWedgedReason(entry: SessionEntry): string;
export declare function evaluateSubagentRecoveryGate(entry: SessionEntry, now: number): SubagentRecoveryGate;
export declare function markSubagentRecoveryAttempt(params: {
    entry: SessionEntry;
    now: number;
    runId: string;
    attempt: number;
}): void;
export declare function markSubagentRecoveryWedged(params: {
    entry: SessionEntry;
    now: number;
    runId?: string;
    reason: string;
}): void;
export declare function clearWedgedSubagentRecoveryAbort(entry: SessionEntry, now: number): boolean;
export {};
