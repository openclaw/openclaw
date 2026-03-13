import type { ChannelStatusIssue } from "../channels/plugins/types.js";
type RuntimeLifecycleSnapshot = {
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
};
export declare function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(accountId: string, extra?: T): {
    accountId: string;
    running: false;
    lastStartAt: null;
    lastStopAt: null;
    lastError: null;
} & T;
export declare function buildBaseChannelStatusSummary(snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
}): {
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
};
export declare function buildProbeChannelStatusSummary<TExtra extends Record<string, unknown>>(snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
}, extra?: TExtra): {
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
} & TExtra & {
    probe: unknown;
    lastProbeAt: number | null;
};
export declare function buildBaseAccountStatusSnapshot(params: {
    account: {
        accountId: string;
        name?: string;
        enabled?: boolean;
        configured?: boolean;
    };
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
}): {
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    accountId: string;
    name: string | undefined;
    enabled: boolean | undefined;
    configured: boolean | undefined;
};
export declare function buildComputedAccountStatusSnapshot(params: {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
}): {
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    accountId: string;
    name: string | undefined;
    enabled: boolean | undefined;
    configured: boolean | undefined;
};
export declare function buildRuntimeAccountStatusSnapshot(params: {
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
}): {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
};
export declare function buildTokenChannelStatusSummary(snapshot: {
    configured?: boolean | null;
    tokenSource?: string | null;
    running?: boolean | null;
    mode?: string | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    probe?: unknown;
    lastProbeAt?: number | null;
}, opts?: {
    includeMode?: boolean;
}): {
    tokenSource: string;
    probe: unknown;
    lastProbeAt: number | null;
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
} | {
    mode: string | null;
    tokenSource: string;
    probe: unknown;
    lastProbeAt: number | null;
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
};
export declare function collectStatusIssuesFromLastError(channel: string, accounts: Array<{
    accountId: string;
    lastError?: unknown;
}>): ChannelStatusIssue[];
export {};
