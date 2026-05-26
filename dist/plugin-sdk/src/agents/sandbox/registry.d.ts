export type SandboxRegistryEntry = {
    containerName: string;
    backendId?: string;
    runtimeLabel?: string;
    sessionKey: string;
    createdAtMs: number;
    lastUsedAtMs: number;
    image: string;
    configLabelKind?: string;
    configHash?: string;
};
type SandboxRegistry = {
    entries: SandboxRegistryEntry[];
};
export type SandboxBrowserRegistryEntry = {
    containerName: string;
    sessionKey: string;
    createdAtMs: number;
    lastUsedAtMs: number;
    image: string;
    configHash?: string;
    cdpPort: number;
    noVncPort?: number;
};
type SandboxBrowserRegistry = {
    entries: SandboxBrowserRegistryEntry[];
};
type LegacyRegistryKind = "containers" | "browsers";
type LegacyRegistryTarget = {
    kind: LegacyRegistryKind;
    registryPath: string;
    shardedDir: string;
};
export type LegacySandboxRegistryInspection = LegacyRegistryTarget & {
    exists: boolean;
    valid: boolean;
    entries: number;
};
export type LegacySandboxRegistryMigrationResult = LegacyRegistryTarget & {
    status: "missing" | "migrated" | "removed-empty" | "quarantined-invalid";
    entries: number;
    quarantinePath?: string;
};
export declare function readRegistry(): Promise<SandboxRegistry>;
export declare function inspectLegacySandboxRegistryFiles(): Promise<LegacySandboxRegistryInspection[]>;
export declare function migrateLegacySandboxRegistryFiles(): Promise<LegacySandboxRegistryMigrationResult[]>;
export declare function readRegistryEntry(containerName: string): Promise<SandboxRegistryEntry | null>;
export declare function updateRegistry(entry: SandboxRegistryEntry): Promise<void>;
export declare function removeRegistryEntry(containerName: string): Promise<void>;
export declare function readBrowserRegistry(): Promise<SandboxBrowserRegistry>;
export declare function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry): Promise<void>;
export declare function removeBrowserRegistryEntry(containerName: string): Promise<void>;
export {};
