export declare function isBlockedLivenessState(livenessState: unknown): boolean;
export declare function formatBlockedLivenessError(error: unknown): string;
export declare function normalizeBlockedLivenessWaitStatus<TStatus extends "ok" | "error" | "timeout" | "pending">(params: {
    status: TStatus;
    livenessState?: unknown;
    error?: unknown;
}): {
    status: TStatus | "error";
    error?: string;
};
