import type { RuntimeEnv } from "../runtime.js";
export type SignalDaemonOpts = {
    cliPath: string;
    account?: string;
    httpHost: string;
    httpPort: number;
    receiveMode?: "on-start" | "manual";
    ignoreAttachments?: boolean;
    ignoreStories?: boolean;
    sendReadReceipts?: boolean;
    runtime?: RuntimeEnv;
};
export type SignalDaemonHandle = {
    pid?: number;
    stop: () => void;
    exited: Promise<SignalDaemonExitEvent>;
    isExited: () => boolean;
};
export type SignalDaemonExitEvent = {
    source: "process" | "spawn-error";
    code: number | null;
    signal: NodeJS.Signals | null;
};
export declare function formatSignalDaemonExit(exit: SignalDaemonExitEvent): string;
export declare function classifySignalCliLogLine(line: string): "log" | "error" | null;
export declare function spawnSignalDaemon(opts: SignalDaemonOpts): SignalDaemonHandle;
