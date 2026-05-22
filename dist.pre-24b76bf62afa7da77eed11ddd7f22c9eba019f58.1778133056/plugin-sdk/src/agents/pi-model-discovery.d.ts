import type { AuthStorage as PiAuthStorage, ModelRegistry as PiModelRegistry } from "@mariozechner/pi-coding-agent";
import { type DiscoverAuthStorageOptions } from "./pi-auth-discovery.js";
declare const PiAuthStorageClass: typeof PiAuthStorage;
declare const PiModelRegistryClass: typeof PiModelRegistry;
export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };
type DiscoverModelsOptions = {
    providerFilter?: string;
    normalizeModels?: boolean;
};
export declare function normalizeDiscoveredPiModel<T>(value: T, agentDir: string): T;
export declare function discoverAuthStorage(agentDir: string, options?: DiscoverAuthStorageOptions): PiAuthStorage;
export declare function discoverModels(authStorage: PiAuthStorage, agentDir: string, options?: DiscoverModelsOptions): PiModelRegistry;
export { addEnvBackedPiCredentials, resolvePiCredentialsForDiscovery, scrubLegacyStaticAuthJsonEntriesForDiscovery, type DiscoverAuthStorageOptions, } from "./pi-auth-discovery.js";
