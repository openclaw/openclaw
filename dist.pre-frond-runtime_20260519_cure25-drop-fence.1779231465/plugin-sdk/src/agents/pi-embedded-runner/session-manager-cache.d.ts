import fs from "node:fs/promises";
export type SessionManagerCache = {
    clear: () => void;
    isSessionManagerCached: (sessionFile: string) => boolean;
    keys: () => string[];
    prewarmSessionFile: (sessionFile: string) => Promise<void>;
    trackSessionManagerAccess: (sessionFile: string) => void;
};
export declare function createSessionManagerCache(options?: {
    clock?: () => number;
    fsModule?: Pick<typeof fs, "open">;
    ttlMs?: number | (() => number);
}): SessionManagerCache;
export declare function trackSessionManagerAccess(sessionFile: string): void;
export declare function prewarmSessionFile(sessionFile: string): Promise<void>;
