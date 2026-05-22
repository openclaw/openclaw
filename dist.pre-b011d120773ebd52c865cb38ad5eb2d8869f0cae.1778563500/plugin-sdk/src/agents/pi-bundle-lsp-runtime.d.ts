import { type ChildProcess } from "node:child_process";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { type StdioMcpServerLaunchConfig } from "./mcp-stdio.js";
import type { AnyAgentTool } from "./tools/common.js";
type LspServerCapabilities = {
    hoverProvider?: boolean;
    completionProvider?: boolean;
    definitionProvider?: boolean;
    referencesProvider?: boolean;
    diagnosticProvider?: boolean;
    [key: string]: unknown;
};
export type BundleLspToolRuntime = {
    tools: AnyAgentTool[];
    sessions: Array<{
        serverName: string;
        capabilities: LspServerCapabilities;
    }>;
    dispose: () => Promise<void>;
};
export declare function spawnLspServerProcess(config: StdioMcpServerLaunchConfig): ChildProcess;
export declare function createBundleLspToolRuntime(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    reservedToolNames?: Iterable<string>;
}): Promise<BundleLspToolRuntime>;
export declare function disposeAllBundleLspRuntimes(): Promise<void>;
export {};
