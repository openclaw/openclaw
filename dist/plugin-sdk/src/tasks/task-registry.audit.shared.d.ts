import type { TaskRecord } from "./task-registry.types.js";
export type TaskAuditSeverity = "warn" | "error";
export type TaskAuditCode = "stale_queued" | "stale_running" | "lost" | "delivery_failed" | "missing_cleanup" | "inconsistent_timestamps";
export type TaskAuditFinding = {
    severity: TaskAuditSeverity;
    code: TaskAuditCode;
    task: TaskRecord;
    ageMs?: number;
    detail: string;
};
export type TaskAuditSummary = {
    total: number;
    warnings: number;
    errors: number;
    byCode: Record<TaskAuditCode, number>;
};
type TaskAuditComparableFinding = {
    severity: TaskAuditSeverity;
    ageMs?: number;
    createdAt: number;
};
export declare function createEmptyTaskAuditSummary(): TaskAuditSummary;
export declare function compareTaskAuditFindingSortKeys(left: TaskAuditComparableFinding, right: TaskAuditComparableFinding): number;
export {};
