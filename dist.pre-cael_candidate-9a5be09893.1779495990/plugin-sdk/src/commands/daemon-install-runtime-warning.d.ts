export type DaemonInstallWarnFn = (message: string, title?: string) => void;
export declare function emitNodeRuntimeWarning(params: {
    env: Record<string, string | undefined>;
    runtime: string;
    nodeProgram?: string;
    warn?: DaemonInstallWarnFn;
    title: string;
}): Promise<void>;
