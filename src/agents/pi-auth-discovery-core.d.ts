import type { PiCredentialMap } from "./pi-auth-credentials.js";
export declare function addEnvBackedPiCredentials(credentials: PiCredentialMap, env?: NodeJS.ProcessEnv): PiCredentialMap;
export declare function scrubLegacyStaticAuthJsonEntriesForDiscovery(pathname: string): void;
