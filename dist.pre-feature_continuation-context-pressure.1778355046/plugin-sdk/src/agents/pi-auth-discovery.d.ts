import { type PiCredentialMap } from "./pi-auth-credentials.js";
import { type PiDiscoveryAuthLookupOptions } from "./pi-auth-discovery-core.js";
export type DiscoverAuthStorageOptions = {
    readOnly?: boolean;
    skipCredentials?: boolean;
} & PiDiscoveryAuthLookupOptions;
export declare function resolvePiCredentialsForDiscovery(agentDir: string, options?: DiscoverAuthStorageOptions): PiCredentialMap;
export { addEnvBackedPiCredentials, scrubLegacyStaticAuthJsonEntriesForDiscovery, } from "./pi-auth-discovery-core.js";
