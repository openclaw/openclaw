export type PendingToolTaskDrainResult = {
    kind: "settled";
} | {
    kind: "timeout";
    remaining: number;
};
type DrainOptions = {
    tasks: Set<Promise<void>>;
    idleTimeoutMs?: number;
    onTimeout?: (message: string) => void;
};
export declare function drainPendingToolTasks({ tasks, idleTimeoutMs, onTimeout }: DrainOptions): Promise<PendingToolTaskDrainResult>;
export {};
