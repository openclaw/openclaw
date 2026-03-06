export declare function isWSLEnv(): boolean;
/**
 * Synchronously check if running in WSL.
 * Checks env vars first, then /proc/version.
 */
export declare function isWSLSync(): boolean;
/**
 * Synchronously check if running in WSL2.
 */
export declare function isWSL2Sync(): boolean;
export declare function isWSL(): Promise<boolean>;
