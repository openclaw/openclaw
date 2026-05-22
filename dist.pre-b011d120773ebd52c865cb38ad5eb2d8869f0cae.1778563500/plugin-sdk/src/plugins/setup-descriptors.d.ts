import type { PluginManifestRecord } from "./manifest-registry.js";
type SetupDescriptorRecord = Pick<PluginManifestRecord, "providers" | "cliBackends" | "setup">;
export declare function listSetupProviderIds(record: SetupDescriptorRecord): readonly string[];
export declare function listSetupCliBackendIds(record: SetupDescriptorRecord): readonly string[];
export {};
