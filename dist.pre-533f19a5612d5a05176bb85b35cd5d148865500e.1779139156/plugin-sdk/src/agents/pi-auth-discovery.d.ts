import type { ExternalCliAuthDiscovery } from "./auth-profiles/external-cli-discovery.js";
import { type PiCredentialMap } from "./pi-auth-credentials.js";
import { type PiDiscoveryAuthLookupOptions } from "./pi-auth-discovery-core.js";
export type DiscoverAuthStorageOptions = {
    externalCli?: ExternalCliAuthDiscovery;
    readOnly?: boolean;
    skipExternalAuthProfiles?: boolean;
    skipCredentials?: boolean;
    syntheticAuthProviderRefs?: Iterable<string>;
} & PiDiscoveryAuthLookupOptions;
export declare function resolvePiCredentialsForDiscovery(agentDir: string, options?: DiscoverAuthStorageOptions): PiCredentialMap;
export { addEnvBackedPiCredentials, scrubLegacyStaticAuthJsonEntriesForDiscovery, } from "./pi-auth-discovery-core.js";
