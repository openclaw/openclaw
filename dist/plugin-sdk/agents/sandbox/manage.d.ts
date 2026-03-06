import { type SandboxBrowserRegistryEntry, type SandboxRegistryEntry } from "./registry.js";
export type SandboxContainerInfo = SandboxRegistryEntry & {
    running: boolean;
    imageMatch: boolean;
};
export type SandboxBrowserInfo = SandboxBrowserRegistryEntry & {
    running: boolean;
    imageMatch: boolean;
};
export declare function listSandboxContainers(): Promise<SandboxContainerInfo[]>;
export declare function listSandboxBrowsers(): Promise<SandboxBrowserInfo[]>;
export declare function removeSandboxContainer(containerName: string): Promise<void>;
export declare function removeSandboxBrowserContainer(containerName: string): Promise<void>;
