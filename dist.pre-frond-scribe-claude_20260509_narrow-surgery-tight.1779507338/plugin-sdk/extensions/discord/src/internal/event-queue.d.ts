export type DiscordEventQueueOptions = {
    maxQueueSize?: number;
    maxConcurrency?: number;
    listenerTimeout?: number;
    slowListenerThreshold?: number;
};
type DiscordEventQueueJob = {
    eventType: string;
    listenerName: string;
    run: () => Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
};
type DiscordEventQueueMetrics = {
    queueSize: number;
    processing: number;
    processed: number;
    dropped: number;
    timeouts: number;
    maxQueueSize: number;
    maxConcurrency: number;
};
export declare class DiscordEventQueue {
    private readonly options;
    private readonly queue;
    private queueHead;
    private processing;
    private processedCount;
    private droppedCount;
    private timeoutCount;
    constructor(options?: DiscordEventQueueOptions);
    enqueue(params: Omit<DiscordEventQueueJob, "resolve" | "reject">): Promise<void>;
    getMetrics(): DiscordEventQueueMetrics;
    private get pendingQueueSize();
    private takeNextJob;
    private processNext;
    private runJob;
    private runWithTimeout;
    private logSlowListener;
}
export {};
