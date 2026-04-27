import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { BundleMcpToolRuntime, SessionMcpRuntime } from "./pi-bundle-mcp-types.js";
export declare function materializeBundleMcpToolsForRun(params: {
    runtime: SessionMcpRuntime;
    reservedToolNames?: Iterable<string>;
    disposeRuntime?: () => Promise<void>;
}): Promise<BundleMcpToolRuntime>;
export declare function createBundleMcpToolRuntime(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
    reservedToolNames?: Iterable<string>;
    createRuntime?: (params: {
        sessionId: string;
        workspaceDir: string;
        cfg?: OpenClawConfig;
    }) => SessionMcpRuntime;
}): Promise<BundleMcpToolRuntime>;
