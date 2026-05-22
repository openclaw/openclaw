export type ActiveProcessSessionReference = {
    sessionId: string;
    status: "running";
    pid?: number;
    startedAt: number;
    runtimeMs: number;
    cwd?: string;
    command: string;
    name: string;
    tail?: string;
    truncated: boolean;
};
export declare function listActiveProcessSessionReferences(params: {
    scopeKey?: string;
    now?: number;
    limit?: number;
}): ActiveProcessSessionReference[];
export declare function formatActiveProcessSessionReference(session: ActiveProcessSessionReference): string;
