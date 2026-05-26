import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ChannelPlugin } from "./types.plugin.js";
import type { ChannelAccountSnapshot } from "./types.public.js";
export declare function buildChannelAccountSnapshotFromAccount<ResolvedAccount>(params: {
    plugin: ChannelPlugin<ResolvedAccount>;
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime?: ChannelAccountSnapshot;
    probe?: unknown;
    audit?: unknown;
    enabledFallback?: boolean;
    configuredFallback?: boolean;
}): Promise<ChannelAccountSnapshot>;
export declare function buildReadOnlySourceChannelAccountSnapshot<ResolvedAccount>(params: {
    plugin: ChannelPlugin<ResolvedAccount>;
    cfg: OpenClawConfig;
    accountId: string;
    runtime?: ChannelAccountSnapshot;
    probe?: unknown;
    audit?: unknown;
}): Promise<ChannelAccountSnapshot | null>;
export declare function buildChannelAccountSnapshot<ResolvedAccount>(params: {
    plugin: ChannelPlugin<ResolvedAccount>;
    cfg: OpenClawConfig;
    accountId: string;
    runtime?: ChannelAccountSnapshot;
    probe?: unknown;
    audit?: unknown;
}): Promise<ChannelAccountSnapshot>;
