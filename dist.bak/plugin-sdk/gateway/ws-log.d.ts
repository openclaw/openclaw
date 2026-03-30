export declare function shouldLogWs(): boolean;
export declare function shortId(value: string): string;
export declare function formatForLog(value: unknown): string;
export declare function summarizeAgentEventForWsLog(payload: unknown): Record<string, unknown>;
export declare function logWs(direction: "in" | "out", kind: string, meta?: Record<string, unknown>): void;
