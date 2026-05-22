import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
export type TaskRegistryProcessState = {
    tasks: Map<string, TaskRecord>;
    taskDeliveryStates: Map<string, TaskDeliveryState>;
    taskIdsByRunId: Map<string, Set<string>>;
    taskIdsByOwnerKey: Map<string, Set<string>>;
    taskIdsByParentFlowId: Map<string, Set<string>>;
    taskIdsByRelatedSessionKey: Map<string, Set<string>>;
    tasksWithPendingDelivery: Set<string>;
};
export declare function getTaskRegistryProcessState(): TaskRegistryProcessState;
