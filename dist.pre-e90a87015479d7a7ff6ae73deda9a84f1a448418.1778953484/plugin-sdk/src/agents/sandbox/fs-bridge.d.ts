import type { SandboxFsBridgeContext } from "./backend-handle.types.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";
export type { SandboxFsBridge, SandboxFsStat, SandboxResolvedPath } from "./fs-bridge.types.js";
export declare function createSandboxFsBridge(params: {
    sandbox: SandboxFsBridgeContext;
}): SandboxFsBridge;
