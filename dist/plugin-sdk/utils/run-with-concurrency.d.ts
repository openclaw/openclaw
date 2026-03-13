export type ConcurrencyErrorMode = "continue" | "stop";
export declare function runTasksWithConcurrency<T>(params: {
    tasks: Array<() => Promise<T>>;
    limit: number;
    errorMode?: ConcurrencyErrorMode;
    onTaskError?: (error: unknown, index: number) => void;
}): Promise<{
    results: T[];
    firstError: unknown;
    hasError: boolean;
}>;
