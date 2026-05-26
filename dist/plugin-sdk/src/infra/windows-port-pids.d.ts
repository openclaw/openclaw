export type WindowsListeningPidsResult = {
    ok: true;
    pids: number[];
} | {
    ok: false;
    permanent: boolean;
};
export type WindowsProcessArgsResult = {
    ok: true;
    args: string[] | null;
} | {
    ok: false;
    permanent: boolean;
};
export declare function readWindowsListeningPidsOnPortSync(port: number, timeoutMs?: number): number[];
export declare function readWindowsListeningPidsResultSync(port: number, timeoutMs?: number): WindowsListeningPidsResult;
export declare function readWindowsProcessArgsSync(pid: number, timeoutMs?: number): string[] | null;
export declare function readWindowsProcessArgsResultSync(pid: number, timeoutMs?: number): WindowsProcessArgsResult;
