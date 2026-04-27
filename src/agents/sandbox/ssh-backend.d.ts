import type { CreateSandboxBackendParams, SandboxBackendHandle, SandboxBackendManager } from "./backend.types.js";
export declare const sshSandboxBackendManager: SandboxBackendManager;
export declare function createSshSandboxBackend(params: CreateSandboxBackendParams): Promise<SandboxBackendHandle>;
