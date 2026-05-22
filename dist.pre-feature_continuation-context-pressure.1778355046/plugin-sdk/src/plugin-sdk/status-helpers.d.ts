import type { ChannelStatusAdapter } from "../channels/plugins/types.adapters.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
import type { ChannelStatusIssue } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
export type { ChannelAccountSnapshot } from "../channels/plugins/types.core.js";
export type { ChannelStatusIssue } from "../channels/plugins/types.public.js";
export { isRecord } from "../channels/plugins/status-issues/shared.js";
export { appendMatchMetadata, asString, collectIssuesForEnabledAccounts, formatMatchMetadata, resolveEnabledConfiguredAccountId, } from "../channels/plugins/status-issues/shared.js";
type RuntimeLifecycleSnapshot = {
    running?: boolean | null;
    connected?: boolean | null;
    restartPending?: boolean | null;
    reconnectAttempts?: number | null;
    lastConnectedAt?: number | null;
    lastDisconnect?: string | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
    } | null;
    lastEventAt?: number | null;
    lastTransportActivityAt?: number | null;
    healthState?: string | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
    lastInboundAt?: number | null;
    lastOutboundAt?: number | null;
};
type StatusSnapshotExtra = Record<string, unknown>;
type ComputedAccountStatusBase = {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
};
type ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit> = {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
    runtime?: ChannelAccountSnapshot;
    probe?: Probe;
    audit?: Audit;
};
type ComputedAccountStatusSnapshot<TExtra extends StatusSnapshotExtra = StatusSnapshotExtra> = ComputedAccountStatusBase & {
    extra?: TExtra;
};
type ConfigIssueAccount = {
    accountId?: string | null;
    configured?: boolean | null;
} & Record<string, unknown>;
/** Create the baseline runtime snapshot shape used by channel/account status stores. */
export declare function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(accountId: string, extra?: T): {
    accountId: string;
    running: false;
    lastStartAt: null;
    lastStopAt: null;
    lastError: null;
} & T;
/** Normalize a channel-level status summary so missing lifecycle fields become explicit nulls. */
export declare function buildBaseChannelStatusSummary<TExtra extends StatusSnapshotExtra>(snapshot: {
    configured?: boolean | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
}, extra?: TExtra): {
    configured: boolean;
} & TExtra & {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
};
/** Extend the base summary with probe fields while preserving stable null defaults. */
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
} & TExtra & {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    lastProbeAt: number | null;
};
/** Build webhook channel summaries with a stable default mode. */
export declare function buildWebhookChannelStatusSummary<TExtra extends StatusSnapshotExtra>(snapshot: {
    configured?: boolean | null;
    mode?: string | null;
    running?: boolean | null;
    lastStartAt?: number | null;
    lastStopAt?: number | null;
    lastError?: string | null;
}, extra?: TExtra): {
    configured: boolean;
} & {
    mode: string;
} & TExtra & {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
};
/** Build the standard per-account status payload from config metadata plus runtime state. */
export declare function buildBaseAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(params: {
    account: {
        accountId: string;
        name?: string;
        enabled?: boolean;
        configured?: boolean;
    };
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
}, extra?: TExtra): {
    accountId: string;
    name: string | undefined;
    enabled: boolean | undefined;
    configured: boolean | undefined;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    connected?: boolean | undefined;
    restartPending?: boolean | undefined;
    reconnectAttempts?: number | undefined;
    lastConnectedAt?: number | undefined;
    lastDisconnect?: string | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
    } | undefined;
    lastEventAt?: number | undefined;
    lastTransportActivityAt?: number | undefined;
    healthState?: string | undefined;
} & TExtra;
/** Convenience wrapper when the caller already has flattened account fields instead of an account object. */
export declare function buildComputedAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(params: {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
}, extra?: TExtra): {
    accountId: string;
    name: string | undefined;
    enabled: boolean | undefined;
    configured: boolean | undefined;
    lastInboundAt: number | null;
    lastOutboundAt: number | null;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    connected?: boolean | undefined;
    restartPending?: boolean | undefined;
    reconnectAttempts?: number | undefined;
    lastConnectedAt?: number | undefined;
    lastDisconnect?: string | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
    } | undefined;
    lastEventAt?: number | undefined;
    lastTransportActivityAt?: number | undefined;
    healthState?: string | undefined;
} & TExtra;
/** Build a full status adapter when only configured/extras vary per account. */
export declare function createComputedAccountStatusAdapter<ResolvedAccount, Probe = unknown, Audit = unknown, TExtra extends StatusSnapshotExtra = StatusSnapshotExtra>(options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> & {
    resolveAccountSnapshot: (params: ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit>) => ComputedAccountStatusSnapshot<TExtra>;
}): ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
/** Async variant for channels that compute configured state or snapshot extras from I/O. */
export declare function createAsyncComputedAccountStatusAdapter<ResolvedAccount, Probe = unknown, Audit = unknown, TExtra extends StatusSnapshotExtra = StatusSnapshotExtra>(options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> & {
    resolveAccountSnapshot: (params: ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit>) => Promise<ComputedAccountStatusSnapshot<TExtra>>;
}): ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
/** Normalize runtime-only account state into the shared status snapshot fields. */
export declare function buildRuntimeAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(params: {
    runtime?: RuntimeLifecycleSnapshot | null;
    probe?: unknown;
}, extra?: TExtra): {
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    probe: unknown;
    connected?: boolean | undefined;
    restartPending?: boolean | undefined;
    reconnectAttempts?: number | undefined;
    lastConnectedAt?: number | undefined;
    lastDisconnect?: string | {
        at: number;
        status?: number;
        error?: string;
        loggedOut?: boolean;
    } | undefined;
    lastEventAt?: number | undefined;
    lastTransportActivityAt?: number | undefined;
    healthState?: string | undefined;
} & TExtra;
/** Build token-based channel status summaries with optional mode reporting. */
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
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    tokenSource: string;
    probe: unknown;
    lastProbeAt: number | null;
} | {
    configured: boolean;
    running: boolean;
    lastStartAt: number | null;
    lastStopAt: number | null;
    lastError: string | null;
    tokenSource: string;
    probe: unknown;
    lastProbeAt: number | null;
    mode: string | null;
};
/** Build a config-issue collector from snapshot-safe source metadata only. */
export declare function createDependentCredentialStatusIssueCollector(options: {
    channel: string;
    dependencySourceKey: string;
    missingPrimaryMessage: string;
    missingDependentMessage: string;
    isDependencyConfigured?: ((value: unknown) => boolean) | undefined;
}): (accounts: ConfigIssueAccount[]) => ChannelStatusIssue[];
/** Convert account runtime errors into the generic channel status issue format. */
export declare function collectStatusIssuesFromLastError(channel: string, accounts: Array<{
    accountId: string;
    lastError?: unknown;
}>): ChannelStatusIssue[];
