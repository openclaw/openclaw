type NormalizeSubagentTaskNameResult = {
    taskName?: string;
    error?: undefined;
} | {
    taskName?: undefined;
    error: string;
};
export declare function normalizeSubagentTaskName(value: unknown): NormalizeSubagentTaskNameResult;
export {};
