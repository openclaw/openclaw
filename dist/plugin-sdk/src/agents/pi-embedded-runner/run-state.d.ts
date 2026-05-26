export type EmbeddedPiQueueHandle = {
    kind?: "embedded";
    queueMessage: (text: string, options?: EmbeddedPiQueueMessageOptions) => Promise<void>;
    isStreaming: () => boolean;
    isCompacting: () => boolean;
    cancel?: (reason?: "user_abort" | "restart" | "superseded") => void;
    abort: () => void;
};
export type EmbeddedPiQueueMessageOptions = {
    steeringMode?: "all" | "one-at-a-time";
    debounceMs?: number;
};
export type ActiveEmbeddedRunSnapshot = {
    transcriptLeafId: string | null;
    messages?: unknown[];
    inFlightPrompt?: string;
};
export type EmbeddedRunModelSwitchRequest = {
    provider: string;
    model: string;
    authProfileId?: string;
    authProfileIdSource?: "auto" | "user";
};
export type EmbeddedRunWaiter = {
    resolve: (ended: boolean) => void;
    timer: NodeJS.Timeout;
};
export declare const ACTIVE_EMBEDDED_RUNS: Map<string, EmbeddedPiQueueHandle>;
export declare const ACTIVE_EMBEDDED_RUN_SNAPSHOTS: Map<string, ActiveEmbeddedRunSnapshot>;
export declare const ACTIVE_EMBEDDED_RUN_SESSION_IDS_BY_KEY: Map<string, string>;
export declare const EMBEDDED_RUN_WAITERS: Map<string, Set<EmbeddedRunWaiter>>;
export declare const EMBEDDED_RUN_MODEL_SWITCH_REQUESTS: Map<string, EmbeddedRunModelSwitchRequest>;
export declare function getActiveEmbeddedRunCount(): number;
