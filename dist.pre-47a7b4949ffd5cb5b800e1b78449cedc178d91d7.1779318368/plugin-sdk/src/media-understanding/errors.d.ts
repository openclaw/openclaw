type MediaUnderstandingSkipReason = "maxBytes" | "timeout" | "unsupported" | "empty" | "blocked" | "tooSmall";
export declare class MediaUnderstandingSkipError extends Error {
    readonly reason: MediaUnderstandingSkipReason;
    constructor(reason: MediaUnderstandingSkipReason, message: string);
}
export declare function isMediaUnderstandingSkipError(err: unknown): err is MediaUnderstandingSkipError;
export {};
