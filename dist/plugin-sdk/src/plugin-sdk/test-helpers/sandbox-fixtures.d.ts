import type { SandboxBrowserConfig, SandboxPruneConfig, SandboxSshConfig } from "../../agents/sandbox/types.js";
export declare function createSandboxBrowserConfig(overrides?: Partial<SandboxBrowserConfig>): SandboxBrowserConfig;
export declare function createSandboxPruneConfig(overrides?: Partial<SandboxPruneConfig>): SandboxPruneConfig;
export declare function createSandboxSshConfig(workspaceRoot: string, overrides?: Partial<SandboxSshConfig>): SandboxSshConfig;
