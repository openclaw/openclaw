type EmbeddedPiQueueHandle = {
    queueMessage: (text: string) => Promise<void>;
    isStreaming: () => boolean;
    isCompacting: () => boolean;
    abort: () => void;
};
export declare function queueEmbeddedPiMessage(sessionId: string, text: string): boolean;
export declare function abortEmbeddedPiRun(sessionId: string): boolean;
export declare function isEmbeddedPiRunActive(sessionId: string): boolean;
export declare function isEmbeddedPiRunStreaming(sessionId: string): boolean;
export declare function getActiveEmbeddedRunCount(): number;
export declare function waitForEmbeddedPiRunEnd(sessionId: string, timeoutMs?: number): Promise<boolean>;
export declare function setActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
export declare function clearActiveEmbeddedRun(sessionId: string, handle: EmbeddedPiQueueHandle, sessionKey?: string): void;
export type { EmbeddedPiQueueHandle };
