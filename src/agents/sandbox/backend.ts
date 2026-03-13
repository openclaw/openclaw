export type SandboxBackendKind = "docker" | "opensandbox";

/**
 * Backend-agnostic sandbox handle used by tool/runtime layers.
 * `metadata` is intentionally opaque so each backend can evolve independently.
 */
export type SandboxBackendHandle = {
  kind: SandboxBackendKind;
  metadata?: Record<string, string>;
};

/**
 * Minimal backend contract for decoupling gateway orchestration from sandbox runtime.
 * Current codebase only wires docker execution; OpenSandbox can implement this contract
 * incrementally without changing higher-level tool orchestration logic.
 */
export interface SandboxBackend {
  kind: SandboxBackendKind;
  ensureSession(params: {
    sessionKey: string;
    workspaceDir: string;
    agentWorkspaceDir: string;
  }): Promise<SandboxBackendHandle>;
  destroySession(params: { sessionKey: string }): Promise<void>;
}
