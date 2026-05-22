import { type ResolverContext, type SecretDefaults } from "./runtime-shared.js";
export type ChannelAccountEntry = {
    accountId: string;
    account: Record<string, unknown>;
    enabled: boolean;
};
export type ChannelAccountSurface = {
    hasExplicitAccounts: boolean;
    channelEnabled: boolean;
    accounts: ChannelAccountEntry[];
};
export type ChannelAccountPredicate = (entry: ChannelAccountEntry) => boolean;
export declare function getChannelRecord(config: {
    channels?: Record<string, unknown>;
}, channelKey: string): Record<string, unknown> | undefined;
export declare function getChannelSurface(config: {
    channels?: Record<string, unknown>;
}, channelKey: string): {
    channel: Record<string, unknown>;
    surface: ChannelAccountSurface;
} | null;
export declare function resolveChannelAccountSurface(channel: Record<string, unknown>): ChannelAccountSurface;
export declare function isBaseFieldActiveForChannelSurface(surface: ChannelAccountSurface, rootKey: string): boolean;
export declare function normalizeSecretStringValue(value: unknown): string;
export declare function hasConfiguredSecretInputValue(value: unknown, defaults: SecretDefaults | undefined): boolean;
export declare function collectSimpleChannelFieldAssignments(params: {
    channelKey: string;
    field: string;
    channel: Record<string, unknown>;
    surface: ChannelAccountSurface;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    topInactiveReason: string;
    accountInactiveReason: string;
}): void;
export declare function collectConditionalChannelFieldAssignments(params: {
    channelKey: string;
    field: string;
    channel: Record<string, unknown>;
    surface: ChannelAccountSurface;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    topLevelActiveWithoutAccounts: boolean;
    topLevelInheritedAccountActive: ChannelAccountPredicate;
    accountActive: ChannelAccountPredicate;
    topInactiveReason: string;
    accountInactiveReason: string | ((entry: ChannelAccountEntry) => string);
}): void;
export declare function collectNestedChannelFieldAssignments(params: {
    channelKey: string;
    nestedKey: string;
    field: string;
    channel: Record<string, unknown>;
    surface: ChannelAccountSurface;
    defaults: SecretDefaults | undefined;
    context: ResolverContext;
    topLevelActive: boolean;
    topInactiveReason: string;
    accountActive: ChannelAccountPredicate;
    accountInactiveReason: string | ((entry: ChannelAccountEntry) => string);
}): void;
