import type { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";
type DiscoveryStores = {
    authStorage: AuthStorage;
    modelRegistry: ModelRegistry;
};
type DiscoverCachedPiStoresOptions = {
    agentDir: string;
    inheritedAuthDir?: string;
};
export declare function discoverCachedPiStores(options: DiscoverCachedPiStoresOptions): DiscoveryStores;
export declare function resetModelDiscoveryCacheForTest(): void;
export {};
