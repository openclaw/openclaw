import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import { note } from "../terminal/note.js";
import type { DoctorPrompter } from "./doctor-prompter.js";
type LegacyManifestContractMigration = {
    manifestPath: string;
    pluginId: string;
    nextRaw: Record<string, unknown>;
    changeLines: string[];
};
export declare function collectLegacyPluginManifestContractMigrations(params?: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    manifestRoots?: string[];
    workspaceDir?: string;
}): LegacyManifestContractMigration[];
export declare function maybeRepairLegacyPluginManifestContracts(params: {
    config?: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    manifestRoots?: string[];
    workspaceDir?: string;
    runtime: RuntimeEnv;
    prompter: DoctorPrompter;
    note?: typeof note;
}): Promise<void>;
export {};
