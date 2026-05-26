import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { F as ChannelStatusIssue, r as ChannelAccountSnapshot } from "./types.core-BkmTlRzr.js";
import { U as ChannelStatusAdapter } from "./types.adapters-y0dBEomF.js";
//#region src/channels/plugins/status-issues/shared.d.ts
declare function asString(value: unknown): string | undefined;
declare function formatMatchMetadata(params: {
  matchKey?: unknown;
  matchSource?: unknown;
}): string | undefined;
declare function appendMatchMetadata(message: string, params: {
  matchKey?: unknown;
  matchSource?: unknown;
}): string;
declare function resolveEnabledConfiguredAccountId(account: {
  accountId?: unknown;
  enabled?: unknown;
  configured?: unknown;
}): string | null;
declare function collectIssuesForEnabledAccounts<T extends {
  accountId?: unknown;
  enabled?: unknown;
}>(params: {
  accounts: ChannelAccountSnapshot[];
  readAccount: (value: ChannelAccountSnapshot) => T | null;
  collectIssues: (params: {
    account: T;
    accountId: string;
    issues: ChannelStatusIssue[];
  }) => void;
}): ChannelStatusIssue[];
//#endregion
//#region src/plugin-sdk/status-helpers.d.ts
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
declare function createDefaultChannelRuntimeState<T extends Record<string, unknown>>(accountId: string, extra?: T): {
  accountId: string;
  running: false;
  lastStartAt: null;
  lastStopAt: null;
  lastError: null;
} & T;
/** Normalize a channel-level status summary so missing lifecycle fields become explicit nulls. */
declare function buildBaseChannelStatusSummary<TExtra extends StatusSnapshotExtra>(snapshot: {
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
declare function buildProbeChannelStatusSummary<TExtra extends Record<string, unknown>>(snapshot: {
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
  probe: unknown;
  lastProbeAt: number | null;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
};
/** Build webhook channel summaries with a stable default mode. */
declare function buildWebhookChannelStatusSummary<TExtra extends StatusSnapshotExtra>(snapshot: {
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
declare function buildBaseAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(params: {
  account: {
    accountId: string;
    name?: string;
    enabled?: boolean;
    configured?: boolean;
  };
  runtime?: RuntimeLifecycleSnapshot | null;
  probe?: unknown;
}, extra?: TExtra): {
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  healthState?: string | undefined;
  lastTransportActivityAt?: number | undefined;
  lastEventAt?: number | undefined;
  lastDisconnect?: string | {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | undefined;
  lastConnectedAt?: number | undefined;
  reconnectAttempts?: number | undefined;
  restartPending?: boolean | undefined;
  connected?: boolean | undefined;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  probe: unknown;
  accountId: string;
  name: string | undefined;
  enabled: boolean | undefined;
  configured: boolean | undefined;
} & TExtra;
/** Convenience wrapper when the caller already has flattened account fields instead of an account object. */
declare function buildComputedAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(params: {
  accountId: string;
  name?: string;
  enabled?: boolean;
  configured?: boolean;
  runtime?: RuntimeLifecycleSnapshot | null;
  probe?: unknown;
}, extra?: TExtra): {
  lastInboundAt: number | null;
  lastOutboundAt: number | null;
  healthState?: string | undefined;
  lastTransportActivityAt?: number | undefined;
  lastEventAt?: number | undefined;
  lastDisconnect?: string | {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | undefined;
  lastConnectedAt?: number | undefined;
  reconnectAttempts?: number | undefined;
  restartPending?: boolean | undefined;
  connected?: boolean | undefined;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  probe: unknown;
  accountId: string;
  name: string | undefined;
  enabled: boolean | undefined;
  configured: boolean | undefined;
} & TExtra;
/** Build a full status adapter when only configured/extras vary per account. */
declare function createComputedAccountStatusAdapter<ResolvedAccount, Probe = unknown, Audit = unknown, TExtra extends StatusSnapshotExtra = StatusSnapshotExtra>(options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> & {
  resolveAccountSnapshot: (params: ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit>) => ComputedAccountStatusSnapshot<TExtra>;
}): ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
/** Async variant for channels that compute configured state or snapshot extras from I/O. */
declare function createAsyncComputedAccountStatusAdapter<ResolvedAccount, Probe = unknown, Audit = unknown, TExtra extends StatusSnapshotExtra = StatusSnapshotExtra>(options: Omit<ChannelStatusAdapter<ResolvedAccount, Probe, Audit>, "buildAccountSnapshot"> & {
  resolveAccountSnapshot: (params: ComputedAccountStatusAdapterParams<ResolvedAccount, Probe, Audit>) => Promise<ComputedAccountStatusSnapshot<TExtra>>;
}): ChannelStatusAdapter<ResolvedAccount, Probe, Audit>;
/** Normalize runtime-only account state into the shared status snapshot fields. */
declare function buildRuntimeAccountStatusSnapshot<TExtra extends StatusSnapshotExtra>(params: {
  runtime?: RuntimeLifecycleSnapshot | null;
  probe?: unknown;
}, extra?: TExtra): {
  healthState?: string | undefined;
  lastTransportActivityAt?: number | undefined;
  lastEventAt?: number | undefined;
  lastDisconnect?: string | {
    at: number;
    status?: number;
    error?: string;
    loggedOut?: boolean;
  } | undefined;
  lastConnectedAt?: number | undefined;
  reconnectAttempts?: number | undefined;
  restartPending?: boolean | undefined;
  connected?: boolean | undefined;
  running: boolean;
  lastStartAt: number | null;
  lastStopAt: number | null;
  lastError: string | null;
  probe: unknown;
} & TExtra;
/** Build token-based channel status summaries with optional mode reporting. */
declare function buildTokenChannelStatusSummary(snapshot: {
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
/** Build a config-issue collector from snapshot-safe source metadata only. */
declare function createDependentCredentialStatusIssueCollector(options: {
  channel: string;
  dependencySourceKey: string;
  missingPrimaryMessage: string;
  missingDependentMessage: string;
  isDependencyConfigured?: ((value: unknown) => boolean) | undefined;
}): (accounts: ConfigIssueAccount[]) => ChannelStatusIssue[];
/** Convert account runtime errors into the generic channel status issue format. */
declare function collectStatusIssuesFromLastError(channel: string, accounts: Array<{
  accountId: string;
  lastError?: unknown;
}>): ChannelStatusIssue[];
//#endregion
export { resolveEnabledConfiguredAccountId as _, buildRuntimeAccountStatusSnapshot as a, collectStatusIssuesFromLastError as c, createDefaultChannelRuntimeState as d, createDependentCredentialStatusIssueCollector as f, formatMatchMetadata as g, collectIssuesForEnabledAccounts as h, buildProbeChannelStatusSummary as i, createAsyncComputedAccountStatusAdapter as l, asString as m, buildBaseChannelStatusSummary as n, buildTokenChannelStatusSummary as o, appendMatchMetadata as p, buildComputedAccountStatusSnapshot as r, buildWebhookChannelStatusSummary as s, buildBaseAccountStatusSnapshot as t, createComputedAccountStatusAdapter as u };