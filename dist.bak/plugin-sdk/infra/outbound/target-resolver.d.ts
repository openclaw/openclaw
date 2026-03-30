import type { ChannelDirectoryEntry, ChannelDirectoryEntryKind, ChannelId } from "../../channels/plugins/types.js";
import type { OpenClawConfig } from "../../config/config.js";
import { type RuntimeEnv } from "../../runtime.js";
export type TargetResolveKind = ChannelDirectoryEntryKind | "channel";
export type ResolveAmbiguousMode = "error" | "best" | "first";
export type ResolvedMessagingTarget = {
    to: string;
    kind: TargetResolveKind;
    display?: string;
    source: "normalized" | "directory";
};
export type ResolveMessagingTargetResult = {
    ok: true;
    target: ResolvedMessagingTarget;
} | {
    ok: false;
    error: Error;
    candidates?: ChannelDirectoryEntry[];
};
export declare function resolveChannelTarget(params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    input: string;
    accountId?: string | null;
    preferredKind?: TargetResolveKind;
    runtime?: RuntimeEnv;
}): Promise<ResolveMessagingTargetResult>;
export declare function resetDirectoryCache(params?: {
    channel?: ChannelId;
    accountId?: string | null;
}): void;
export declare function formatTargetDisplay(params: {
    channel: ChannelId;
    target: string;
    display?: string;
    kind?: ChannelDirectoryEntryKind;
}): string;
export declare function resolveMessagingTarget(params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    input: string;
    accountId?: string | null;
    preferredKind?: TargetResolveKind;
    runtime?: RuntimeEnv;
    resolveAmbiguous?: ResolveAmbiguousMode;
}): Promise<ResolveMessagingTargetResult>;
export declare function lookupDirectoryDisplay(params: {
    cfg: OpenClawConfig;
    channel: ChannelId;
    targetId: string;
    accountId?: string | null;
    runtime?: RuntimeEnv;
}): Promise<string | undefined>;
