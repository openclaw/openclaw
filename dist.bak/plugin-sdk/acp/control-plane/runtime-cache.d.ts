import type { AcpRuntime, AcpRuntimeHandle, AcpRuntimeSessionMode } from "../runtime/types.js";
export type CachedRuntimeState = {
    runtime: AcpRuntime;
    handle: AcpRuntimeHandle;
    backend: string;
    agent: string;
    mode: AcpRuntimeSessionMode;
    cwd?: string;
    appliedControlSignature?: string;
};
export type CachedRuntimeSnapshot = {
    actorKey: string;
    state: CachedRuntimeState;
    lastTouchedAt: number;
    idleMs: number;
};
export declare class RuntimeCache {
    private readonly cache;
    size(): number;
    has(actorKey: string): boolean;
    get(actorKey: string, params?: {
        touch?: boolean;
        now?: number;
    }): CachedRuntimeState | null;
    peek(actorKey: string): CachedRuntimeState | null;
    getLastTouchedAt(actorKey: string): number | null;
    set(actorKey: string, state: CachedRuntimeState, params?: {
        now?: number;
    }): void;
    clear(actorKey: string): void;
    snapshot(params?: {
        now?: number;
    }): CachedRuntimeSnapshot[];
    collectIdleCandidates(params: {
        maxIdleMs: number;
        now?: number;
    }): CachedRuntimeSnapshot[];
}
