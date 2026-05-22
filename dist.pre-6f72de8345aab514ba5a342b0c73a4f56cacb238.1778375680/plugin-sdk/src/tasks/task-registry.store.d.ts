import type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
import type { TaskDeliveryState, TaskRecord } from "./task-registry.types.js";
export type { TaskRegistryStoreSnapshot } from "./task-registry.store.types.js";
export type TaskRegistryStore = {
    loadSnapshot: () => TaskRegistryStoreSnapshot;
    saveSnapshot: (snapshot: TaskRegistryStoreSnapshot) => void;
    upsertTaskWithDeliveryState?: (params: {
        task: TaskRecord;
        deliveryState?: TaskDeliveryState;
    }) => void;
    upsertTask?: (task: TaskRecord) => void;
    deleteTaskWithDeliveryState?: (taskId: string) => void;
    deleteTask?: (taskId: string) => void;
    upsertDeliveryState?: (state: TaskDeliveryState) => void;
    deleteDeliveryState?: (taskId: string) => void;
    close?: () => void;
};
export type TaskRegistryObserverEvent = {
    kind: "restored";
    tasks: TaskRecord[];
} | {
    kind: "upserted";
    task: TaskRecord;
    previous?: TaskRecord;
} | {
    kind: "deleted";
    taskId: string;
    previous: TaskRecord;
};
export type TaskRegistryObservers = {
    onEvent?: (event: TaskRegistryObserverEvent) => void;
};
export declare function getTaskRegistryStore(): TaskRegistryStore;
export declare function getTaskRegistryObservers(): TaskRegistryObservers | null;
export declare function configureTaskRegistryRuntime(params: {
    store?: TaskRegistryStore;
    observers?: TaskRegistryObservers | null;
}): void;
export declare function resetTaskRegistryRuntimeForTests(): void;
