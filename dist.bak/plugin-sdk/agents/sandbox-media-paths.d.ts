import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";
export type SandboxedBridgeMediaPathConfig = {
    root: string;
    bridge: SandboxFsBridge;
    workspaceOnly?: boolean;
};
export declare function resolveSandboxedBridgeMediaPath(params: {
    sandbox: SandboxedBridgeMediaPathConfig;
    mediaPath: string;
    inboundFallbackDir?: string;
}): Promise<{
    resolved: string;
    rewrittenFrom?: string;
}>;
