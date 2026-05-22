export declare const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5000;
export declare class PluginHostCleanupTimeoutError extends Error {
    constructor(hookId: string);
}
export declare function withPluginHostCleanupTimeout<T>(hookId: string, cleanup: () => T | Promise<T>): Promise<T>;
