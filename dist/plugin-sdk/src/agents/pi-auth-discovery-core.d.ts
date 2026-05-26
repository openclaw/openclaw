import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PiCredentialMap } from "./pi-auth-credentials.js";
export type PiDiscoveryAuthLookupOptions = {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
};
export declare function addEnvBackedPiCredentials(credentials: PiCredentialMap, options?: PiDiscoveryAuthLookupOptions): PiCredentialMap;
export declare function scrubLegacyStaticAuthJsonEntriesForDiscovery(pathname: string): void;
