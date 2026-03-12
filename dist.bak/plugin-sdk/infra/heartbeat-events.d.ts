export type HeartbeatIndicatorType = "ok" | "alert" | "error";
export type HeartbeatEventPayload = {
    ts: number;
    status: "sent" | "ok-empty" | "ok-token" | "skipped" | "failed";
    to?: string;
    accountId?: string;
    preview?: string;
    durationMs?: number;
    hasMedia?: boolean;
    reason?: string;
    /** The channel this heartbeat was sent to. */
    channel?: string;
    /** Whether the message was silently suppressed (showOk: false). */
    silent?: boolean;
    /** Indicator type for UI status display. */
    indicatorType?: HeartbeatIndicatorType;
};
export declare function resolveIndicatorType(status: HeartbeatEventPayload["status"]): HeartbeatIndicatorType | undefined;
export declare function emitHeartbeatEvent(evt: Omit<HeartbeatEventPayload, "ts">): void;
export declare function onHeartbeatEvent(listener: (evt: HeartbeatEventPayload) => void): () => void;
export declare function getLastHeartbeatEvent(): HeartbeatEventPayload | null;
