import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { TerminationReason } from "../process/supervisor/types.js";
import type { DeliveryContext } from "../utils/delivery-context.js";
export type ProcessStatus = "running" | "completed" | "failed" | "killed";
export type SessionStdin = {
    write: (data: string, cb?: (err?: Error | null) => void) => void;
    end: () => void;
    destroy?: () => void;
    destroyed?: boolean;
};
export interface ProcessSession {
    id: string;
    command: string;
    scopeKey?: string;
    sessionKey?: string;
    notifyDeliveryContext?: DeliveryContext;
    notifyOnExit?: boolean;
    notifyOnExitEmptySuccess?: boolean;
    exitNotified?: boolean;
    child?: ChildProcessWithoutNullStreams;
    stdin?: SessionStdin;
    pid?: number;
    startedAt: number;
    cwd?: string;
    maxOutputChars: number;
    pendingMaxOutputChars?: number;
    totalOutputChars: number;
    pendingStdout: string[];
    pendingStderr: string[];
    pendingStdoutChars: number;
    pendingStderrChars: number;
    aggregated: string;
    tail: string;
    exitCode?: number | null;
    exitSignal?: NodeJS.Signals | number | null;
    exitReason?: TerminationReason;
    exited: boolean;
    truncated: boolean;
    backgrounded: boolean;
    /** PTY cursor key mode: unknown until a PTY reports smkx/rmkx. */
    cursorKeyMode: "unknown" | "normal" | "application";
}
export interface FinishedSession {
    id: string;
    command: string;
    scopeKey?: string;
    startedAt: number;
    endedAt: number;
    cwd?: string;
    status: ProcessStatus;
    exitCode?: number | null;
    exitSignal?: NodeJS.Signals | number | null;
    exitReason?: TerminationReason;
    aggregated: string;
    tail: string;
    truncated: boolean;
    totalOutputChars: number;
}
export declare function createSessionSlug(): string;
export declare function addSession(session: ProcessSession): void;
export declare function getSession(id: string): ProcessSession | undefined;
export declare function getFinishedSession(id: string): FinishedSession | undefined;
export declare function deleteSession(id: string): void;
export declare function appendOutput(session: ProcessSession, stream: "stdout" | "stderr", chunk: string): void;
export declare function drainSession(session: ProcessSession): {
    stdout: string;
    stderr: string;
};
export declare function markExited(session: ProcessSession, exitCode: number | null, exitSignal: NodeJS.Signals | number | null, status: ProcessStatus, exitReason?: TerminationReason): void;
export declare function markBackgrounded(session: ProcessSession): void;
export declare function tail(text: string, max?: number): string;
export declare function trimWithCap(text: string, max: number): string;
export declare function listRunningSessions(): ProcessSession[];
export declare function listFinishedSessions(): FinishedSession[];
export declare function clearFinished(): void;
export declare function resetProcessRegistryForTests(): void;
export declare function setJobTtlMs(value?: number): void;
