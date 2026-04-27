import type { SandboxBackendCommandResult } from "./backend-handle.types.js";
export type SshSandboxSettings = {
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
export type SshSandboxSession = {
    command: string;
    configPath: string;
    host: string;
};
export type RunSshSandboxCommandParams = {
    session: SshSandboxSession;
    remoteCommand: string;
    stdin?: Buffer | string;
    allowFailure?: boolean;
    signal?: AbortSignal;
    tty?: boolean;
};
export declare function shellEscape(value: string): string;
export declare function buildRemoteCommand(argv: string[]): string;
export declare function buildExecRemoteCommand(params: {
    command: string;
    workdir?: string;
    env: Record<string, string>;
}): string;
export declare function buildSshSandboxArgv(params: {
    session: SshSandboxSession;
    remoteCommand: string;
    tty?: boolean;
}): string[];
export declare function createSshSandboxSessionFromConfigText(params: {
    configText: string;
    host?: string;
    command?: string;
}): Promise<SshSandboxSession>;
export declare function createSshSandboxSessionFromSettings(settings: SshSandboxSettings): Promise<SshSandboxSession>;
export declare function disposeSshSandboxSession(session: SshSandboxSession): Promise<void>;
export declare function runSshSandboxCommand(params: RunSshSandboxCommandParams): Promise<SandboxBackendCommandResult>;
export declare function uploadDirectoryToSshTarget(params: {
    session: SshSandboxSession;
    localDir: string;
    remoteDir: string;
    signal?: AbortSignal;
}): Promise<void>;
