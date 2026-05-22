import type { TaskRecord } from "./task-registry.types.js";
export declare function getTaskSessionLookupByIdForStatus(taskId: string): Pick<TaskRecord, "requesterSessionKey" | "runId" | "agentId"> | undefined;
export declare function listTasksForSessionKeyForStatus(sessionKey: string): TaskRecord[];
export declare function listTasksForAgentIdForStatus(agentId: string): TaskRecord[];
