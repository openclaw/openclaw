type ProgressOptions = {
    label: string;
    indeterminate?: boolean;
    total?: number;
    enabled?: boolean;
    delayMs?: number;
    stream?: NodeJS.WriteStream;
    fallback?: "spinner" | "line" | "log" | "none";
};
export type ProgressReporter = {
    setLabel: (label: string) => void;
    setPercent: (percent: number) => void;
    tick: (delta?: number) => void;
    done: () => void;
};
export type ProgressTotalsUpdate = {
    completed: number;
    total: number;
    label?: string;
};
export declare function createCliProgress(options: ProgressOptions): ProgressReporter;
export declare function withProgress<T>(options: ProgressOptions, work: (progress: ProgressReporter) => Promise<T>): Promise<T>;
export declare function withProgressTotals<T>(options: ProgressOptions, work: (update: (update: ProgressTotalsUpdate) => void, progress: ProgressReporter) => Promise<T>): Promise<T>;
export {};
