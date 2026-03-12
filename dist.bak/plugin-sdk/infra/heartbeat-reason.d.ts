export type HeartbeatReasonKind = "retry" | "interval" | "manual" | "exec-event" | "wake" | "cron" | "hook" | "other";
export declare function normalizeHeartbeatWakeReason(reason?: string): string;
export declare function resolveHeartbeatReasonKind(reason?: string): HeartbeatReasonKind;
export declare function isHeartbeatEventDrivenReason(reason?: string): boolean;
export declare function isHeartbeatActionWakeReason(reason?: string): boolean;
