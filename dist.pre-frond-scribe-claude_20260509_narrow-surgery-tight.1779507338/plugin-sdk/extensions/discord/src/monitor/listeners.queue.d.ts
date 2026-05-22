export type DiscordListenerLogger = ReturnType<typeof import("openclaw/plugin-sdk/runtime-env").createSubsystemLogger>;
export declare const discordEventQueueLog: import("openclaw/plugin-sdk/runtime-env").SubsystemLogger;
export declare function runDiscordListenerWithSlowLog(params: {
    logger: DiscordListenerLogger | undefined;
    listener: string;
    event: string;
    run: () => Promise<void>;
    context?: Record<string, unknown>;
    onError?: (err: unknown) => void;
}): Promise<void>;
