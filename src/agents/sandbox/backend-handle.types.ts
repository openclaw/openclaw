import type { SandboxFsBridge } from "./fs-bridge.types.js";

export type SandboxBackendId = string;

export type SandboxBackendExecSpec = {
  argv: string[];
  env: NodeJS.ProcessEnv;
  /** Local transport cwd, independent of the remote command's workdir. */
  cwd?: string;
  stdinMode: "pipe-open" | "pipe-closed";
  /** Synchronously revalidate runtime authority at deferred process admission. */
  assertCurrent?: () => void;
  finalizeToken?: unknown;
};

export type SandboxBackendWorkdirValidation = "host" | "backend";

export type SandboxBackendWorkdirValidator = (workdir: string) => Promise<string | null>;
export type SandboxBackendPreparedWorkdirDiscarder = (workdir: string) => void;

export type SandboxBackendCommandParams = {
  script: string;
  args?: string[];
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
  /**
   * Caller authority fence for mutating commands. A backend must call it
   * synchronously after all of its own awaited launch preparation and
   * immediately before starting the command.
   */
  assertBeforeMutation?: () => void;
};

export type SandboxBackendCommandResult = {
  stdout: Buffer;
  stderr: Buffer;
  code: number;
};

export type SandboxFsBridgeContext = {
  workspaceDir: string;
  agentWorkspaceDir: string;
  skillsWorkspaceDir?: string;
  readOnlyResourceMounts?: Array<{ hostPath: string; containerPath: string }>;
  workspaceAccess: "none" | "ro" | "rw";
  containerName: string;
  containerWorkdir: string;
  docker: {
    binds?: string[];
    tmpfs?: string[];
  };
  backend?: {
    runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
    /** See SandboxBackendHandle.enforcesMutationFence. */
    readonly enforcesMutationFence?: true;
  };
};

export type SandboxBackendHandle = {
  id: SandboxBackendId;
  runtimeId: string;
  runtimeLabel: string;
  workdir: string;
  env?: Record<string, string>;
  configLabel?: string;
  configLabelKind?: string;
  /**
   * Remote backends own cwd existence checks because valid runtime paths may
   * not exist in the local workspace mirror. Backend validation must be paired
   * with validateWorkdir so cwd is proved after before_tool_call adjustments
   * and before env resolution, approval, preflight, and launch.
   */
  workdirValidation?: SandboxBackendWorkdirValidation;
  validateWorkdir?: SandboxBackendWorkdirValidator;
  /** Discard one-shot state created while validating a backend-owned cwd. */
  discardPreparedWorkdir?: SandboxBackendPreparedWorkdirDiscarder;
  /** Remote cwd roots managed by backend validation. Defaults to workdir. */
  workdirRoots?: readonly string[];
  capabilities?: {
    browser?: boolean;
    readOnlyResourceMounts?: boolean;
  };
  /**
   * Declares that `runShellCommand` calls `SandboxBackendCommandParams.assertBeforeMutation`
   * synchronously after all of its own awaited launch preparation and right before
   * starting the command. The default filesystem bridge only advertises
   * `enforcesMutationFence` when its backend declares this.
   */
  readonly enforcesMutationFence?: true;
  buildExecSpec(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
    usePty: boolean;
  }): Promise<SandboxBackendExecSpec>;
  finalizeExec?: (params: {
    status: "completed" | "failed";
    exitCode: number | null;
    timedOut: boolean;
    token?: unknown;
  }) => Promise<void>;
  /** Mint termination-only custody while execution is admitted; retained cleanup cannot run arbitrary commands. */
  prepareProcessCleanup?: (env: Record<string, string>) => {
    env: Record<string, string>;
    terminate: () => Promise<void>;
    /** Interrupt may run guest signal handlers, so it retains ordinary live execution checks. */
    interrupt: (timeoutMs: number) => Promise<boolean>;
  };
  runShellCommand(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
  createFsBridge?: (params: { sandbox: SandboxFsBridgeContext }) => SandboxFsBridge;
};
