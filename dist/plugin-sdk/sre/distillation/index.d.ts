import type { SessionEntry } from "../../config/sessions/types.js";
export type DistilledSummarySections = {
    decisions: string[];
    openTodos: string[];
    constraints: string[];
    pendingAsks: string[];
    identifiers: string[];
};
export type DistillationWriteResult = {
    dossierPath?: string;
    memoryNotePath?: string;
};
type SessionContext = {
    sessionEntry?: SessionEntry;
    sessionFile?: string;
    sessionId?: string;
    workspaceDir?: string;
};
type CompactionDistillationInput = SessionContext & {
    summary: string;
};
type SubagentDistillationInput = {
    childSessionKey: string;
    requesterSessionKey?: string;
    runId?: string;
    reason: string;
    outcome?: string;
    error?: string;
};
export declare function extractDistilledSummarySections(summary: string): DistilledSummarySections;
export declare function distillCompactionSummary(input: CompactionDistillationInput): Promise<DistillationWriteResult>;
export declare function distillSubagentOutcome(input: SubagentDistillationInput): Promise<DistillationWriteResult>;
export {};
