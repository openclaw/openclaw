import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { n as PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types-CemL6rws.js";
//#region src/secrets/provider-env-vars.d.ts
type ProviderEnvVarLookupParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  includeUntrustedWorkspacePlugins?: boolean;
  metadataSnapshot?: PluginMetadataSnapshot;
};
type ProviderAuthEvidence = {
  type: "local-file-with-env";
  fileEnvVar?: string;
  fallbackPaths?: readonly string[];
  requiresAnyEnv?: readonly string[];
  requiresAllEnv?: readonly string[];
  credentialMarker: string;
  source?: string;
};
declare function resolveProviderAuthEnvVarCandidates(params?: ProviderEnvVarLookupParams): Record<string, readonly string[]>;
declare function getProviderEnvVars(providerId: string, params?: ProviderEnvVarLookupParams): string[];
declare function listKnownProviderAuthEnvVarNames(params?: ProviderEnvVarLookupParams): string[];
declare function omitEnvKeysCaseInsensitive(baseEnv: NodeJS.ProcessEnv, keys: Iterable<string>): NodeJS.ProcessEnv;
//#endregion
export { resolveProviderAuthEnvVarCandidates as a, omitEnvKeysCaseInsensitive as i, getProviderEnvVars as n, listKnownProviderAuthEnvVarNames as r, ProviderAuthEvidence as t };