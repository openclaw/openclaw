import type { RuntimeEnv } from "../runtime.js";
export type TransportReadyResult = {
    ok: boolean;
    error?: string | null;
};
export type WaitForTransportReadyParams = {
    label: string;
    timeoutMs: number;
    logAfterMs?: number;
    logIntervalMs?: number;
    pollIntervalMs?: number;
    abortSignal?: AbortSignal;
    runtime: RuntimeEnv;
    check: () => Promise<TransportReadyResult>;
};
export declare function waitForTransportReady(params: WaitForTransportReadyParams): Promise<void>;
