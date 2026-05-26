import type { SandboxBackendCommandParams } from "./backend-handle.types.js";
import type { CreateSandboxBackendParams, SandboxBackendHandle, SandboxBackendManager } from "./backend.types.js";
export declare function createDockerSandboxBackend(params: CreateSandboxBackendParams): Promise<SandboxBackendHandle>;
export declare function runDockerSandboxShellCommand(params: {
    containerName: string;
} & SandboxBackendCommandParams): Promise<import("./docker.js").ExecDockerRawResult>;
export declare const dockerSandboxBackendManager: SandboxBackendManager;
