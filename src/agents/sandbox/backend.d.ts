import type { SandboxBackendFactory, SandboxBackendManager, SandboxBackendRegistration } from "./backend.types.js";
export type { CreateSandboxBackendParams, SandboxBackendFactory, SandboxBackendId, SandboxBackendManager, SandboxBackendRegistration, SandboxBackendRuntimeInfo, } from "./backend.types.js";
export type { SandboxBackendCommandParams, SandboxBackendCommandResult, SandboxBackendExecSpec, SandboxBackendHandle, SandboxFsBridgeContext, } from "./backend-handle.types.js";
export declare function registerSandboxBackend(id: string, registration: SandboxBackendRegistration): () => void;
export declare function getSandboxBackendFactory(id: string): SandboxBackendFactory | null;
export declare function getSandboxBackendManager(id: string): SandboxBackendManager | null;
export declare function requireSandboxBackendFactory(id: string): SandboxBackendFactory;
