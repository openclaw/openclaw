type BatchOutputErrorLike = {
    error?: {
        message?: string;
    };
    response?: {
        body?: string | {
            error?: {
                message?: string;
            };
        };
    };
};
export declare function extractBatchErrorMessage(lines: BatchOutputErrorLike[]): string | undefined;
export declare function formatUnavailableBatchError(err: unknown): string | undefined;
export {};
