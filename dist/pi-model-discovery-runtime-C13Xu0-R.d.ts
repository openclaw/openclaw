import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { m as ExternalCliAuthDiscovery } from "./store-BFaKoEBr.js";
import * as PiCodingAgent from "@earendil-works/pi-coding-agent";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

//#region src/agents/pi-auth-credentials.d.ts
type PiApiKeyCredential = {
  type: "api_key";
  key: string;
};
type PiOAuthCredential = {
  type: "oauth";
  access: string;
  refresh: string;
  expires: number;
};
type PiCredential = PiApiKeyCredential | PiOAuthCredential;
type PiCredentialMap = Record<string, PiCredential>;
//#endregion
//#region src/agents/pi-auth-discovery-core.d.ts
type PiDiscoveryAuthLookupOptions = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
};
declare function addEnvBackedPiCredentials(credentials: PiCredentialMap, options?: PiDiscoveryAuthLookupOptions): PiCredentialMap;
declare function scrubLegacyStaticAuthJsonEntriesForDiscovery(pathname: string): void;
//#endregion
//#region src/agents/pi-auth-discovery.d.ts
type DiscoverAuthStorageOptions = {
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  skipExternalAuthProfiles?: boolean;
  skipCredentials?: boolean;
  syntheticAuthProviderRefs?: Iterable<string>;
} & PiDiscoveryAuthLookupOptions;
declare function resolvePiCredentialsForDiscovery(agentDir: string, options?: DiscoverAuthStorageOptions): PiCredentialMap;
//#endregion
//#region src/agents/pi-model-discovery.d.ts
declare const PiAuthStorageClass: typeof PiCodingAgent.AuthStorage;
declare const PiModelRegistryClass: typeof PiCodingAgent.ModelRegistry;
type DiscoverModelsOptions = {
  providerFilter?: string;
  normalizeModels?: boolean;
};
declare function normalizeDiscoveredPiModel<T>(value: T, agentDir: string): T;
declare function discoverAuthStorage(agentDir: string, options?: DiscoverAuthStorageOptions): AuthStorage;
declare function discoverModels(authStorage: AuthStorage, agentDir: string, options?: DiscoverModelsOptions): ModelRegistry;
declare namespace pi_model_discovery_runtime_d_exports {
  export { PiAuthStorageClass as AuthStorage, PiModelRegistryClass as ModelRegistry, addEnvBackedPiCredentials, discoverAuthStorage, discoverModels, normalizeDiscoveredPiModel, resolvePiCredentialsForDiscovery, scrubLegacyStaticAuthJsonEntriesForDiscovery };
}
//#endregion
export { discoverModels as a, addEnvBackedPiCredentials as c, discoverAuthStorage as i, scrubLegacyStaticAuthJsonEntriesForDiscovery as l, PiAuthStorageClass as n, normalizeDiscoveredPiModel as o, PiModelRegistryClass as r, resolvePiCredentialsForDiscovery as s, pi_model_discovery_runtime_d_exports as t };