import type { TaskRecord, TaskRegistrySummary } from "./task-registry.types.js";
export declare function createEmptyTaskRegistrySummary(): TaskRegistrySummary;
export declare function summarizeTaskRecords(records: Iterable<TaskRecord>): TaskRegistrySummary;
