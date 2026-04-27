import { type PiCredentialMap } from "./pi-auth-credentials.js";
export type DiscoverAuthStorageOptions = {
    readOnly?: boolean;
};
export declare function resolvePiCredentialsForDiscovery(agentDir: string, options?: DiscoverAuthStorageOptions): PiCredentialMap;
export { addEnvBackedPiCredentials, scrubLegacyStaticAuthJsonEntriesForDiscovery, } from "./pi-auth-discovery-core.js";
