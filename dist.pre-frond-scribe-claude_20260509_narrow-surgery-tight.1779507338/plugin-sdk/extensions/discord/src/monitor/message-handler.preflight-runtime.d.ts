export declare function loadPluralKitRuntime(): Promise<typeof import("../pluralkit.js")>;
export declare function loadPreflightAudioRuntime(): Promise<typeof import("./preflight-audio.js")>;
export declare function loadSystemEventsRuntime(): Promise<typeof import("./system-events.js")>;
export declare function loadDiscordThreadingRuntime(): Promise<typeof import("./threading.js")>;
export declare function isPreflightAborted(abortSignal?: AbortSignal): boolean;
