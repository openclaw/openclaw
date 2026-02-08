export type SandboxDockerConfig = {
  image: string;
  containerPrefix: string;
  workdir: string;
  readOnlyRoot: boolean;
  tmpfs: string[];
  network: string;
  user?: string;
  capDrop: string[];
  env?: Record<string, string>;
  setupCommand?: string;
  pidsLimit?: number;
  memory?: string | number;
  memorySwap?: string | number;
  cpus?: number;
  ulimits?: Record<string, string | number | { soft?: number; hard?: number }>;
  seccompProfile?: string;
  apparmorProfile?: string;
  dns?: string[];
  extraHosts?: string[];
  binds?: string[];
  /**
   * Additional paths (inside the container) that are allowed for read operations.
   * Useful for bind-mounted paths outside the workspace root.
   * Example: ["/workspace/.skills"] to allow reading from bind-mounted skills.
   */
  allowedReadPaths?: string[];
};
