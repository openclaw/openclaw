import type { AuthProfileStore } from "./types.js";
export declare function getRuntimeAuthProfileStoreSnapshot(agentDir?: string): AuthProfileStore | undefined;
export declare function hasRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean;
export declare function hasAnyRuntimeAuthProfileStoreSource(agentDir?: string): boolean;
export declare function replaceRuntimeAuthProfileStoreSnapshots(entries: Array<{
    agentDir?: string;
    store: AuthProfileStore;
}>): void;
export declare function clearRuntimeAuthProfileStoreSnapshots(): void;
export declare function setRuntimeAuthProfileStoreSnapshot(store: AuthProfileStore, agentDir?: string): void;
