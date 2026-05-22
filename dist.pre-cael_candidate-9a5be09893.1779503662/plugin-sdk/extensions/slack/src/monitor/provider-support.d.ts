import type { SlackChannelResolution } from "../resolve-channels.js";
import type { SlackUserResolution } from "../resolve-users.js";
type SlackAppConstructor = typeof import("@slack/bolt").App;
type SlackHttpReceiverConstructor = typeof import("@slack/bolt").HTTPReceiver;
type SlackSocketModeReceiverConstructor = typeof import("@slack/bolt").SocketModeReceiver;
type SlackSocketModeReceiverOptions = ConstructorParameters<SlackSocketModeReceiverConstructor>[0];
type SlackSocketModeConfig = Pick<SlackSocketModeReceiverOptions, "clientPingTimeout" | "serverPingTimeout" | "pingPongLoggingEnabled">;
type SlackSdkLogger = NonNullable<SlackSocketModeReceiverOptions["logger"]>;
type SlackSocketModeLogger = SlackSdkLogger & {
    getLastMessage: () => string | undefined;
};
export type SlackBoltResolvedExports = {
    App: SlackAppConstructor;
    HTTPReceiver: SlackHttpReceiverConstructor;
    SocketModeReceiver: SlackSocketModeReceiverConstructor;
};
type SlackSocketShutdownClient = {
    shuttingDown?: boolean;
};
type SlackSelfFilterArgs = {
    context?: {
        botId?: string;
        botUserId?: string;
    };
    event?: unknown;
    message?: unknown;
};
export declare function resolveSlackBoltInterop(params: {
    defaultImport: unknown;
    namespaceImport: unknown;
}): SlackBoltResolvedExports;
export declare function publishSlackConnectedStatus(setStatus?: (next: Record<string, unknown>) => void): void;
export declare function publishSlackDisconnectedStatus(setStatus?: (next: Record<string, unknown>) => void, error?: unknown): void;
export declare function createSlackSocketModeLogger(sink?: Pick<typeof console, "debug" | "info" | "warn" | "error">): SlackSocketModeLogger;
export declare function shouldSkipOpenClawSlackSelfEvent(args: SlackSelfFilterArgs): boolean;
export declare function createSlackBoltApp(params: {
    interop: SlackBoltResolvedExports;
    slackMode: "socket" | "http";
    botToken: string;
    appToken?: string;
    signingSecret?: string;
    slackWebhookPath: string;
    clientOptions: Record<string, unknown>;
    socketMode?: SlackSocketModeConfig;
}): {
    app: import("@slack/bolt").default<import("@slack/bolt").StringIndexed>;
    receiver: import("@slack/bolt").HTTPReceiver | import("@slack/bolt").SocketModeReceiver;
    socketModeLogger: SlackSocketModeLogger;
};
export declare function createSlackSocketDisconnectWaiter(app: unknown, abortSignal?: AbortSignal): {
    promise: Promise<{
        event: "disconnect" | "error" | "unable_to_socket_mode_start";
        error?: unknown;
    }>;
    getLatest: () => {
        event: "disconnect" | "error" | "unable_to_socket_mode_start";
        error?: unknown;
    } | undefined;
    cancel: () => void;
    complete: () => void;
};
export declare function startSlackSocketAndWaitForDisconnect(params: {
    app: {
        start: () => unknown;
    };
    abortSignal?: AbortSignal;
    onStarted?: () => void;
}): Promise<{
    event: "disconnect" | "error" | "unable_to_socket_mode_start";
    error?: unknown;
} | null>;
export declare function resolveSlackSocketShutdownClient(app: unknown): SlackSocketShutdownClient | undefined;
export declare function gracefulStopSlackApp(app: {
    stop: () => unknown;
}): Promise<void>;
export declare function formatSlackChannelResolved(entry: SlackChannelResolution): string;
export declare function formatSlackUserResolved(entry: SlackUserResolution): string;
export {};
