export type TypingStartGuard = {
    run: (start: () => Promise<void> | void) => Promise<"started" | "skipped" | "failed" | "tripped">;
    reset: () => void;
    isTripped: () => boolean;
};
export declare function createTypingStartGuard(params: {
    isSealed: () => boolean;
    shouldBlock?: () => boolean;
    onStartError?: (err: unknown) => void;
    maxConsecutiveFailures?: number;
    onTrip?: () => void;
    rethrowOnError?: boolean;
}): TypingStartGuard;
