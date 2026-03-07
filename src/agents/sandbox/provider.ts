/**
 * ISandboxProvider: Pluggable sandbox runtime abstraction.
 *
 * Allows OpenClaw to run agent workloads in different isolation backends
 * (Docker, gVisor, Firecracker MicroVM) through a unified interface.
 */

export type SandboxBackend = "docker" | "gvisor" | "firecracker";

export type SandboxInstanceState = "creating" | "running" | "stopped" | "destroyed";

export type SandboxInstance = {
  id: string;
  backend: SandboxBackend;
  containerName: string;
  state: SandboxInstanceState;
  workdir: string;
  createdAtMs: number;
};

export type SandboxCreateRequest = {
  sessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  workspaceAccess: "none" | "ro" | "rw";
  configHash?: string;
};

export type SandboxExecRequest = {
  command: string;
  workdir?: string;
  env?: Record<string, string>;
  tty?: boolean;
  input?: Buffer | string;
  signal?: AbortSignal;
};

export type SandboxExecResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type SandboxStatus = {
  exists: boolean;
  running: boolean;
  backend: SandboxBackend;
};

export interface ISandboxProvider {
  readonly name: SandboxBackend;

  /**
   * Check if this provider is available on the current system.
   * Returns false if prerequisites are missing (e.g. no Docker, no KVM).
   */
  isAvailable(): Promise<boolean>;

  /**
   * One-time initialization (pull images, verify runtime, etc.).
   */
  initialize(): Promise<void>;

  /**
   * Create and start a sandbox instance.
   * Equivalent to current `ensureSandboxContainer()`.
   */
  ensureInstance(request: SandboxCreateRequest): Promise<SandboxInstance>;

  /**
   * Execute a command inside a running sandbox.
   * Equivalent to current `docker exec` via `buildDockerExecArgs()`.
   */
  exec(instance: SandboxInstance, request: SandboxExecRequest): Promise<SandboxExecResult>;

  /**
   * Execute a raw command (buffer I/O). Used for binary data transfers.
   */
  execRaw(
    instance: SandboxInstance,
    args: string[],
    opts?: { allowFailure?: boolean; input?: Buffer | string; signal?: AbortSignal },
  ): Promise<{ stdout: Buffer; stderr: Buffer; code: number }>;

  /**
   * Get the current status of a sandbox instance.
   */
  status(containerName: string): Promise<SandboxStatus>;

  /**
   * Destroy a sandbox instance and clean up resources.
   */
  destroy(containerName: string): Promise<void>;

  /**
   * List all sandbox instances managed by this provider.
   */
  list(): Promise<SandboxInstance[]>;

  /**
   * Read a label/metadata value from a sandbox instance.
   */
  readLabel(containerName: string, label: string): Promise<string | null>;

  /**
   * Read an environment variable from a sandbox instance config.
   */
  readEnvVar(containerName: string, envVar: string): Promise<string | null>;

  /**
   * Read a mapped port from a sandbox instance.
   */
  readPort(containerName: string, port: number): Promise<number | null>;
}
