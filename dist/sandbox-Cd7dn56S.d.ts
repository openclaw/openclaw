import { i as OpenClawConfig } from "./types.openclaw-DIZy8jcb.js";
import { i as SandboxBackendHandle, n as SandboxBackendCommandResult, o as SandboxFsBridgeContext, s as SandboxFsBridge, t as SandboxBackendCommandParams } from "./backend-handle.types-CV0eiC5x.js";
import { n as SandboxConfig, r as SandboxContext } from "./types-2l948LcS.js";

//#region src/agents/sandbox/context.d.ts
declare function resolveSandboxContext(params: {
  config?: OpenClawConfig;
  sessionKey?: string;
  workspaceDir?: string;
}): Promise<SandboxContext | null>;
//#endregion
//#region src/agents/sandbox/registry.d.ts
type SandboxRegistryEntry = {
  containerName: string;
  backendId?: string;
  runtimeLabel?: string;
  sessionKey: string;
  createdAtMs: number;
  lastUsedAtMs: number;
  image: string;
  configLabelKind?: string;
  configHash?: string;
};
//#endregion
//#region src/agents/sandbox/backend.types.d.ts
type SandboxBackendRuntimeInfo = {
  running: boolean;
  actualConfigLabel?: string;
  configLabelMatch: boolean;
};
type SandboxBackendManager = {
  describeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<SandboxBackendRuntimeInfo>;
  removeRuntime(params: {
    entry: SandboxRegistryEntry;
    config: OpenClawConfig;
    agentId?: string;
  }): Promise<void>;
};
type CreateSandboxBackendParams = {
  sessionKey: string;
  scopeKey: string;
  workspaceDir: string;
  agentWorkspaceDir: string;
  cfg: SandboxConfig;
};
type SandboxBackendFactory = (params: CreateSandboxBackendParams) => Promise<SandboxBackendHandle>;
type SandboxBackendRegistration = SandboxBackendFactory | {
  factory: SandboxBackendFactory;
  manager?: SandboxBackendManager;
};
//#endregion
//#region src/agents/sandbox/backend.d.ts
declare function registerSandboxBackend(id: string, registration: SandboxBackendRegistration): () => void;
declare function getSandboxBackendFactory(id: string): SandboxBackendFactory | null;
declare function getSandboxBackendManager(id: string): SandboxBackendManager | null;
declare function requireSandboxBackendFactory(id: string): SandboxBackendFactory;
//#endregion
//#region src/agents/sandbox/sanitize-env-vars.d.ts
type EnvVarSanitizationResult = {
  allowed: Record<string, string>;
  blocked: string[];
  warnings: string[];
};
type EnvSanitizationOptions = {
  strictMode?: boolean;
  customBlockedPatterns?: ReadonlyArray<RegExp>;
  customAllowedPatterns?: ReadonlyArray<RegExp>;
};
declare function sanitizeEnvVars(envVars: Record<string, string | undefined>, options?: EnvSanitizationOptions): EnvVarSanitizationResult;
//#endregion
//#region src/agents/sandbox/ssh.d.ts
type SshSandboxSettings = {
  command: string;
  target: string;
  strictHostKeyChecking: boolean;
  updateHostKeys: boolean;
  identityFile?: string;
  certificateFile?: string;
  knownHostsFile?: string;
  identityData?: string;
  certificateData?: string;
  knownHostsData?: string;
};
type SshSandboxSession = {
  command: string;
  configPath: string;
  host: string;
};
type RunSshSandboxCommandParams = {
  session: SshSandboxSession;
  remoteCommand: string;
  stdin?: Buffer | string;
  allowFailure?: boolean;
  signal?: AbortSignal;
  tty?: boolean;
};
declare function shellEscape(value: string): string;
declare function buildRemoteCommand(argv: string[]): string;
declare function buildExecRemoteCommand(params: {
  command: string;
  workdir?: string;
  env: Record<string, string>;
}): string;
declare function buildSshSandboxArgv(params: {
  session: SshSandboxSession;
  remoteCommand: string;
  tty?: boolean;
}): string[];
declare function createSshSandboxSessionFromConfigText(params: {
  configText: string;
  host?: string;
  command?: string;
}): Promise<SshSandboxSession>;
declare function createSshSandboxSessionFromSettings(settings: SshSandboxSettings): Promise<SshSandboxSession>;
declare function disposeSshSandboxSession(session: SshSandboxSession): Promise<void>;
declare function runSshSandboxCommand(params: RunSshSandboxCommandParams): Promise<SandboxBackendCommandResult>;
declare function uploadDirectoryToSshTarget(params: {
  session: SshSandboxSession;
  localDir: string;
  remoteDir: string;
  signal?: AbortSignal;
}): Promise<void>;
//#endregion
//#region src/agents/sandbox/remote-fs-bridge.d.ts
type RemoteShellSandboxHandle = {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
  runRemoteShellScript(params: SandboxBackendCommandParams): Promise<SandboxBackendCommandResult>;
};
declare function createRemoteShellSandboxFsBridge(params: {
  sandbox: SandboxFsBridgeContext;
  runtime: RemoteShellSandboxHandle;
}): SandboxFsBridge;
//#endregion
//#region src/agents/sandbox/fs-bridge-rename-targets.d.ts
declare function resolveWritableRenameTargets<T extends {
  containerPath: string;
}>(params: {
  from: string;
  to: string;
  cwd?: string;
  action?: string;
  resolveTarget: (params: {
    filePath: string;
    cwd?: string;
  }) => T;
  ensureWritable: (target: T, action: string) => void;
}): {
  from: T;
  to: T;
};
declare function resolveWritableRenameTargetsForBridge<T extends {
  containerPath: string;
}>(params: {
  from: string;
  to: string;
  cwd?: string;
  action?: string;
}, resolveTarget: (params: {
  filePath: string;
  cwd?: string;
}) => T, ensureWritable: (target: T, action: string) => void): {
  from: T;
  to: T;
};
declare function createWritableRenameTargetResolver<T extends {
  containerPath: string;
}>(resolveTarget: (params: {
  filePath: string;
  cwd?: string;
}) => T, ensureWritable: (target: T, action: string) => void): (params: {
  from: string;
  to: string;
  cwd?: string;
}) => {
  from: T;
  to: T;
};
//#endregion
export { CreateSandboxBackendParams as C, SandboxBackendRuntimeInfo as D, SandboxBackendRegistration as E, resolveSandboxContext as O, requireSandboxBackendFactory as S, SandboxBackendManager as T, uploadDirectoryToSshTarget as _, createRemoteShellSandboxFsBridge as a, getSandboxBackendManager as b, SshSandboxSettings as c, buildSshSandboxArgv as d, createSshSandboxSessionFromConfigText as f, shellEscape as g, runSshSandboxCommand as h, RemoteShellSandboxHandle as i, buildExecRemoteCommand as l, disposeSshSandboxSession as m, resolveWritableRenameTargets as n, RunSshSandboxCommandParams as o, createSshSandboxSessionFromSettings as p, resolveWritableRenameTargetsForBridge as r, SshSandboxSession as s, createWritableRenameTargetResolver as t, buildRemoteCommand as u, sanitizeEnvVars as v, SandboxBackendFactory as w, registerSandboxBackend as x, getSandboxBackendFactory as y };