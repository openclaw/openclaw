export type DraftStreamLoop = {
    update: (text: string) => void;
    flush: () => Promise<void>;
    stop: () => void;
    resetPending: () => void;
    resetThrottleWindow: () => void;
    waitForInFlight: () => Promise<void>;
};
export declare function createDraftStreamLoop(params: {
    throttleMs: number;
    isStopped: () => boolean;
    sendOrEditStreamMessage: (text: string) => Promise<void | boolean>;
}): DraftStreamLoop;
