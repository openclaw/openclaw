export declare const SLACK_SOCKET_RECONNECT_POLICY: {
    readonly initialMs: 2000;
    readonly maxMs: 30000;
    readonly factor: 1.8;
    readonly jitter: 0.25;
    readonly maxAttempts: 12;
};
export type SlackSocketDisconnectEvent = "disconnect" | "unable_to_socket_mode_start" | "error";
type EmitterLike = {
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
    off: (event: string, listener: (...args: unknown[]) => void) => unknown;
};
export declare function getSocketEmitter(app: unknown): EmitterLike | null;
export declare function waitForSlackSocketDisconnect(app: unknown, abortSignal?: AbortSignal): Promise<{
    event: SlackSocketDisconnectEvent;
    error?: unknown;
}>;
/**
 * Detect non-recoverable Slack API / auth errors that should NOT be retried.
 * These indicate permanent credential problems (revoked bot, deactivated account, etc.)
 * and retrying will never succeed — continuing to retry blocks the entire gateway.
 */
export declare function isNonRecoverableSlackAuthError(error: unknown): boolean;
export declare function formatUnknownError(error: unknown): string;
export {};
