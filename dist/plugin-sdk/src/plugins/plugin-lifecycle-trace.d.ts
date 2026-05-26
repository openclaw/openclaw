type TraceDetails = Record<string, boolean | number | string | undefined>;
export declare function tracePluginLifecyclePhase<T>(phase: string, fn: () => T, details?: TraceDetails): T;
export declare function tracePluginLifecyclePhaseAsync<T>(phase: string, fn: () => Promise<T>, details?: TraceDetails): Promise<T>;
export {};
