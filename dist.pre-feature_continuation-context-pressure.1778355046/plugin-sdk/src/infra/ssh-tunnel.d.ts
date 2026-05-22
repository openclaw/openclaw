export type SshParsedTarget = {
    user?: string;
    host: string;
    port: number;
};
export type SshTunnel = {
    parsedTarget: SshParsedTarget;
    localPort: number;
    remotePort: number;
    pid: number | null;
    stderr: string[];
    stop: () => Promise<void>;
};
export declare function parseSshTarget(raw: string): SshParsedTarget | null;
export declare function startSshPortForward(opts: {
    target: string;
    identity?: string;
    localPortPreferred: number;
    remotePort: number;
    timeoutMs: number;
}): Promise<SshTunnel>;
