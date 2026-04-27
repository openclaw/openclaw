import * as PiCodingAgent from "@mariozechner/pi-coding-agent";
import type { AuthStorage as PiAuthStorage, ModelRegistry as PiModelRegistry } from "@mariozechner/pi-coding-agent";
import { type DiscoverAuthStorageOptions } from "./pi-auth-discovery.js";
declare const PiAuthStorageClass: typeof PiCodingAgent.AuthStorage;
declare const PiModelRegistryClass: typeof PiCodingAgent.ModelRegistry;
export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry };
type DiscoverModelsOptions = {
    providerFilter?: string;
};
export declare function normalizeDiscoveredPiModel<T>(value: T, agentDir: string): T;
export declare function discoverAuthStorage(agentDir: string, options?: DiscoverAuthStorageOptions): PiAuthStorage;
export declare function discoverModels(authStorage: PiAuthStorage, agentDir: string, options?: DiscoverModelsOptions): PiModelRegistry;
export { addEnvBackedPiCredentials, resolvePiCredentialsForDiscovery, scrubLegacyStaticAuthJsonEntriesForDiscovery, type DiscoverAuthStorageOptions, } from "./pi-auth-discovery.js";
