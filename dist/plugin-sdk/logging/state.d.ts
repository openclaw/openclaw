export declare const loggingState: {
    cachedLogger: unknown;
    cachedSettings: unknown;
    cachedConsoleSettings: unknown;
    overrideSettings: unknown;
    invalidEnvLogLevelValue: string | null;
    consolePatched: boolean;
    forceConsoleToStderr: boolean;
    consoleTimestampPrefix: boolean;
    consoleSubsystemFilter: string[] | null;
    resolvingConsoleSettings: boolean;
    streamErrorHandlersInstalled: boolean;
    rawConsole: {
        log: typeof console.log;
        info: typeof console.info;
        warn: typeof console.warn;
        error: typeof console.error;
    } | null;
};
