export type TypingController = {
    onReplyStart: () => Promise<void>;
    startTypingLoop: () => Promise<void>;
    startTypingOnText: (text?: string) => Promise<void>;
    refreshTypingTtl: () => void;
    isActive: () => boolean;
    markRunComplete: () => void;
    markDispatchIdle: () => void;
    cleanup: () => void;
};
export declare function createTypingController(params: {
    onReplyStart?: () => Promise<void> | void;
    onCleanup?: () => void;
    typingIntervalSeconds?: number;
    typingTtlMs?: number;
    silentToken?: string;
    log?: (message: string) => void;
}): TypingController;
