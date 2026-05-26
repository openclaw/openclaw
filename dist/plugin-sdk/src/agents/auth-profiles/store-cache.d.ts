import type { AuthProfileStore } from "./types.js";
export declare function readCachedAuthProfileStore(params: {
    authPath: string;
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
}): AuthProfileStore | null;
export declare function writeCachedAuthProfileStore(params: {
    authPath: string;
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
    store: AuthProfileStore;
}): void;
export declare function clearLoadedAuthStoreCache(): void;
