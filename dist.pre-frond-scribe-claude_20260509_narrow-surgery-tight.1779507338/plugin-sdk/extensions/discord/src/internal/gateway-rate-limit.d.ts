export declare class GatewaySendLimiter {
    private sendNow;
    private emitError;
    private outboundSendTimestamps;
    private outboundQueue;
    private outboundFlushTimer?;
    constructor(sendNow: (payload: string) => void, emitError: (error: Error) => void);
    send(serialized: string, options?: {
        critical?: boolean;
    }): void;
    clear(): void;
    getStatus(): {
        remainingEvents: number;
        resetTime: number;
        currentEventCount: number;
        queuedEvents: number;
    };
    private pruneWindow;
    private canSend;
    private sendSerialized;
    private scheduleFlush;
    private flush;
}
