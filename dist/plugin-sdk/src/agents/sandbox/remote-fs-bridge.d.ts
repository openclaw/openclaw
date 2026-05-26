import type { SandboxBackendCommandParams, SandboxBackendCommandResult, SandboxFsBridgeContext } from "./backend-handle.types.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";
export type RemoteShellSandboxHandle = {
    remoteWorkspaceDir: string;
    remoteAgentWorkspaceDir: string;
    runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
};
export declare function createRemoteShellSandboxFsBridge(params: {
    sandbox: SandboxFsBridgeContext;
    runtime: RemoteShellSandboxHandle;
}): SandboxFsBridge;
