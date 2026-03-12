export type SandboxRegistryEntry = {
    containerName: string;
    sessionKey: string;
    createdAtMs: number;
    lastUsedAtMs: number;
    image: string;
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
export declare function readRegistry(): Promise<SandboxRegistry>;
export declare function updateRegistry(entry: SandboxRegistryEntry): Promise<void>;
export declare function removeRegistryEntry(containerName: string): Promise<void>;
export declare function readBrowserRegistry(): Promise<SandboxBrowserRegistry>;
export declare function updateBrowserRegistry(entry: SandboxBrowserRegistryEntry): Promise<void>;
export declare function removeBrowserRegistryEntry(containerName: string): Promise<void>;
export {};
