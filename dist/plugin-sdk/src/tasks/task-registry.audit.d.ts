import { createEmptyTaskAuditSummary, type TaskAuditCode, type TaskAuditFinding, type TaskAuditSeverity, type TaskAuditSummary } from "./task-registry.audit.shared.js";
import type { TaskRecord } from "./task-registry.types.js";
export type TaskAuditOptions = {
    now?: number;
    tasks?: TaskRecord[];
    staleQueuedMs?: number;
    staleRunningMs?: number;
};
export { createEmptyTaskAuditSummary };
export type { TaskAuditCode, TaskAuditFinding, TaskAuditSeverity, TaskAuditSummary };
export declare function configureTaskAuditTaskProvider(provider: () => TaskRecord[]): void;
export declare function listTaskAuditFindings(options?: TaskAuditOptions): TaskAuditFinding[];
export declare function summarizeTaskAuditFindings(findings: Iterable<TaskAuditFinding>): TaskAuditSummary;
