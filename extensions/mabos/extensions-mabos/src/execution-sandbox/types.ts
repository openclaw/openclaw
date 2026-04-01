export interface ExecutionSandboxConfig {
  sandboxEnabled?: boolean;
  defaultBackend?: "local" | "docker" | "ssh" | "modal";
  docker?: {
    image?: string;
    memoryLimitMb?: number;
    cpuLimit?: number;
    networkMode?: "none" | "bridge" | "host";
    timeoutSeconds?: number;
    mountWorkspace?: boolean;
    persistContainer?: boolean;
  };
  ssh?: {
    host?: string;
    port?: number;
    user?: string;
    keyPath?: string;
    workingDir?: string;
  };
  modal?: {
    appName?: string;
    timeoutSeconds?: number;
    gpu?: string;
  };
  perAgent?: Record<string, { backend: "local" | "docker" | "ssh" | "modal" }>;
}

export interface ExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  truncated: boolean;
  backend: string;
}

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface SandboxBackend {
  readonly name: string;
  init(taskId: string): Promise<void>;
  exec(command: string, opts?: ExecOpts): Promise<ExecutionResult>;
  destroy(): Promise<void>;
  isHealthy(): Promise<boolean>;
}
