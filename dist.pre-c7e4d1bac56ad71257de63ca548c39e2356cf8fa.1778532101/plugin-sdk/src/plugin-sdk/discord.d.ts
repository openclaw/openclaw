import type { ChannelAccountSnapshot, ChannelGroupContext, ChannelStatusIssue } from "./channel-contract.js";
import type { ChannelPlugin } from "./channel-core.js";
import type { OpenClawConfig } from "./config-types.js";
/**
 * @deprecated Compatibility facade for the `openclaw/plugin-sdk/discord` subpath.
 * New channel plugins should use generic channel SDK subpaths.
 */
export type { ChannelMessageActionAdapter, ChannelMessageActionName } from "./channel-contract.js";
export type { ChannelPlugin } from "./channel-core.js";
export type { OpenClawConfig } from "./config-types.js";
export type { OpenClawPluginApi, PluginRuntime } from "./channel-plugin-common.js";
export { DEFAULT_ACCOUNT_ID, applyAccountNameToChannelSection, buildChannelConfigSchema, emptyPluginConfigSchema, getChatChannelMeta, migrateBaseNameToDefaultAccount, normalizeAccountId, PAIRING_APPROVED_MESSAGE, } from "./channel-plugin-common.js";
export { buildComputedAccountStatusSnapshot, buildTokenChannelStatusSummary, projectCredentialSnapshotFields, resolveConfiguredFromCredentialStatuses, } from "./channel-status.js";
export { DiscordConfigSchema } from "./bundled-channel-config-schema.js";
export type DiscordAccountConfig = NonNullable<NonNullable<OpenClawConfig["channels"]>["discord"]>;
export type DiscordComponentMessageSpec = {
    text?: string;
    reusable?: boolean;
    container?: {
        accentColor?: string | number;
        spoiler?: boolean;
    };
    blocks?: unknown[];
    modal?: unknown;
};
export type DiscordComponentBuildResult = {
    components: unknown[];
    entries: unknown[];
    modals: unknown[];
};
export type DiscordComponentSendOpts = {
    cfg?: OpenClawConfig;
    accountId?: string;
    replyTo?: string;
    files?: unknown;
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    filename?: string;
    textLimit?: number;
    maxLinesPerMessage?: number;
    tableMode?: unknown;
    chunkMode?: unknown;
    [key: string]: unknown;
};
export type DiscordComponentSendResult = {
    id?: string;
    channel_id?: string;
    [key: string]: unknown;
};
export type ResolvedDiscordAccount = {
    accountId: string;
    enabled: boolean;
    name?: string;
    token: string;
    tokenSource: "env" | "config" | "none";
    config: DiscordAccountConfig;
};
export type DiscordOutboundTargetResolution = {
    ok: true;
    to: string;
} | {
    ok: false;
    error: Error;
};
export type ThreadBindingTargetKind = "subagent" | "acp";
export type ThreadBindingRecord = {
    accountId: string;
    threadId: string;
    channelId?: string;
    targetKind: ThreadBindingTargetKind;
    targetSessionKey: string;
    [key: string]: unknown;
};
type DirectoryConfigParams = {
    cfg: OpenClawConfig;
    accountId?: string | null;
};
type BuildDiscordComponentMessage = (params: {
    spec: DiscordComponentMessageSpec;
    fallbackText?: string;
    sessionKey?: string;
    agentId?: string;
    accountId?: string;
}) => DiscordComponentBuildResult;
type EditDiscordComponentMessage = (to: string, messageId: string, spec: DiscordComponentMessageSpec, opts: DiscordComponentSendOpts) => Promise<DiscordComponentSendResult>;
type RegisterBuiltDiscordComponentMessage = (params: {
    buildResult: DiscordComponentBuildResult;
    messageId: string;
}) => void;
type DiscordApiFacadeModule = {
    collectDiscordStatusIssues: (accounts: ChannelAccountSnapshot[]) => ChannelStatusIssue[];
    buildDiscordComponentMessage: BuildDiscordComponentMessage;
    discordOnboardingAdapter?: NonNullable<ChannelPlugin<ResolvedDiscordAccount>["setup"]>;
    inspectDiscordAccount: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => unknown;
    listDiscordAccountIds: (cfg: OpenClawConfig) => string[];
    listDiscordDirectoryGroupsFromConfig: (params: DirectoryConfigParams) => unknown[] | Promise<unknown[]>;
    listDiscordDirectoryPeersFromConfig: (params: DirectoryConfigParams) => unknown[] | Promise<unknown[]>;
    looksLikeDiscordTargetId: (raw: string) => boolean;
    normalizeDiscordMessagingTarget: (raw: string) => string | undefined;
    normalizeDiscordOutboundTarget: (to?: string) => DiscordOutboundTargetResolution;
    resolveDefaultDiscordAccountId: (cfg: OpenClawConfig) => string;
    resolveDiscordAccount: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => ResolvedDiscordAccount;
    resolveDiscordGroupRequireMention: (params: ChannelGroupContext) => boolean | undefined;
    resolveDiscordGroupToolPolicy: (params: ChannelGroupContext) => unknown;
};
type DiscordRuntimeFacadeModule = {
    editDiscordComponentMessage: EditDiscordComponentMessage;
    registerBuiltDiscordComponentMessage: RegisterBuiltDiscordComponentMessage;
    autoBindSpawnedDiscordSubagent: (params: {
        cfg: OpenClawConfig;
        accountId?: string;
        channel?: string;
        to?: string;
        threadId?: string | number;
        childSessionKey: string;
        agentId: string;
        label?: string;
        boundBy?: string;
    }) => Promise<ThreadBindingRecord | null>;
    collectDiscordAuditChannelIds: (params: {
        cfg: OpenClawConfig;
        accountId?: string | null;
    }) => unknown;
    listThreadBindingsBySessionKey: (params: {
        targetSessionKey: string;
        accountId?: string;
        targetKind?: ThreadBindingTargetKind;
    }) => ThreadBindingRecord[];
    unbindThreadBindingsBySessionKey: (params: {
        targetSessionKey: string;
        accountId?: string;
        targetKind?: ThreadBindingTargetKind;
        reason?: string;
        sendFarewell?: boolean;
        farewellText?: string;
    }) => ThreadBindingRecord[];
};
export declare const discordOnboardingAdapter: {};
export declare function collectDiscordStatusIssues(accounts: ChannelAccountSnapshot[]): ChannelStatusIssue[];
export declare const buildDiscordComponentMessage: DiscordApiFacadeModule["buildDiscordComponentMessage"];
export declare function inspectDiscordAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): unknown;
export declare function listDiscordAccountIds(cfg: OpenClawConfig): string[];
export declare function listDiscordDirectoryGroupsFromConfig(params: DirectoryConfigParams): unknown[] | Promise<unknown[]>;
export declare function listDiscordDirectoryPeersFromConfig(params: DirectoryConfigParams): unknown[] | Promise<unknown[]>;
export declare function looksLikeDiscordTargetId(raw: string): boolean;
export declare function normalizeDiscordMessagingTarget(raw: string): string | undefined;
export declare function normalizeDiscordOutboundTarget(to?: string): DiscordOutboundTargetResolution;
export declare function resolveDefaultDiscordAccountId(cfg: OpenClawConfig): string;
export declare function resolveDiscordAccount(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): ResolvedDiscordAccount;
export declare function resolveDiscordGroupRequireMention(params: ChannelGroupContext): boolean | undefined;
export declare function resolveDiscordGroupToolPolicy(params: ChannelGroupContext): unknown;
export declare function collectDiscordAuditChannelIds(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): unknown;
export declare const editDiscordComponentMessage: DiscordRuntimeFacadeModule["editDiscordComponentMessage"];
export declare const registerBuiltDiscordComponentMessage: DiscordRuntimeFacadeModule["registerBuiltDiscordComponentMessage"];
export declare function autoBindSpawnedDiscordSubagent(params: {
    cfg?: OpenClawConfig;
    accountId?: string;
    channel?: string;
    to?: string;
    threadId?: string | number;
    childSessionKey: string;
    agentId: string;
    label?: string;
    boundBy?: string;
}): Promise<ThreadBindingRecord | null>;
export declare function listThreadBindingsBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
}): ThreadBindingRecord[];
export declare function unbindThreadBindingsBySessionKey(params: {
    targetSessionKey: string;
    accountId?: string;
    targetKind?: ThreadBindingTargetKind;
    reason?: string;
    sendFarewell?: boolean;
    farewellText?: string;
}): ThreadBindingRecord[];
