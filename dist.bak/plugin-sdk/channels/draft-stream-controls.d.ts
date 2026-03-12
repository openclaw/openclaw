export type FinalizableDraftStreamState = {
    stopped: boolean;
    final: boolean;
};
type StopAndClearMessageIdParams<T> = {
    stopForClear: () => Promise<void>;
    readMessageId: () => T | undefined;
    clearMessageId: () => void;
};
type ClearFinalizableDraftMessageParams<T> = StopAndClearMessageIdParams<T> & {
    isValidMessageId: (value: unknown) => value is T;
    deleteMessage: (messageId: T) => Promise<void>;
    onDeleteSuccess?: (messageId: T) => void;
    warn?: (message: string) => void;
    warnPrefix: string;
};
type FinalizableDraftLifecycleParams<T> = Omit<ClearFinalizableDraftMessageParams<T>, "stopForClear"> & {
    throttleMs: number;
    state: FinalizableDraftStreamState;
    sendOrEditStreamMessage: (text: string) => Promise<boolean>;
};
export declare function createFinalizableDraftStreamControls(params: {
    throttleMs: number;
    isStopped: () => boolean;
    isFinal: () => boolean;
    markStopped: () => void;
    markFinal: () => void;
    sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}): {
    loop: import("./draft-stream-loop.js").DraftStreamLoop;
    update: (text: string) => void;
    stop: () => Promise<void>;
    stopForClear: () => Promise<void>;
};
export declare function createFinalizableDraftStreamControlsForState(params: {
    throttleMs: number;
    state: FinalizableDraftStreamState;
    sendOrEditStreamMessage: (text: string) => Promise<boolean>;
}): {
    loop: import("./draft-stream-loop.js").DraftStreamLoop;
    update: (text: string) => void;
    stop: () => Promise<void>;
    stopForClear: () => Promise<void>;
};
export declare function takeMessageIdAfterStop<T>(params: StopAndClearMessageIdParams<T>): Promise<T | undefined>;
export declare function clearFinalizableDraftMessage<T>(params: ClearFinalizableDraftMessageParams<T>): Promise<void>;
export declare function createFinalizableDraftLifecycle<T>(params: FinalizableDraftLifecycleParams<T>): {
    clear: () => Promise<void>;
    loop: import("./draft-stream-loop.js").DraftStreamLoop;
    update: (text: string) => void;
    stop: () => Promise<void>;
    stopForClear: () => Promise<void>;
};
export {};
