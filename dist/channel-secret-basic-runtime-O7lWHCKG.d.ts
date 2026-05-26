import { r as SecretDefaults, t as ResolverContext } from "./runtime-shared-CPtO2jTZ.js";

//#region src/secrets/channel-secret-basic-runtime.d.ts
type ChannelAccountEntry = {
  accountId: string;
  account: Record<string, unknown>;
  enabled: boolean;
};
type ChannelAccountSurface = {
  hasExplicitAccounts: boolean;
  channelEnabled: boolean;
  accounts: ChannelAccountEntry[];
};
type ChannelAccountPredicate = (entry: ChannelAccountEntry) => boolean;
declare function getChannelRecord(config: {
  channels?: Record<string, unknown>;
}, channelKey: string): Record<string, unknown> | undefined;
declare function getChannelSurface(config: {
  channels?: Record<string, unknown>;
}, channelKey: string): {
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
} | null;
declare function resolveChannelAccountSurface(channel: Record<string, unknown>): ChannelAccountSurface;
declare function isBaseFieldActiveForChannelSurface(surface: ChannelAccountSurface, rootKey: string): boolean;
declare function normalizeSecretStringValue(value: unknown): string;
declare function hasConfiguredSecretInputValue(value: unknown, defaults: SecretDefaults | undefined): boolean;
declare function collectSimpleChannelFieldAssignments(params: {
  channelKey: string;
  field: string;
  channel: Record<string, unknown>;
  surface: ChannelAccountSurface;
  defaults: SecretDefaults | undefined;
  context: ResolverContext;
  topInactiveReason: string;
  accountInactiveReason: string;
}): void;
declare function collectConditionalChannelFieldAssignments(params: {
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
declare function collectNestedChannelFieldAssignments(params: {
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
//#endregion
export { collectNestedChannelFieldAssignments as a, getChannelSurface as c, normalizeSecretStringValue as d, resolveChannelAccountSurface as f, collectConditionalChannelFieldAssignments as i, hasConfiguredSecretInputValue as l, ChannelAccountPredicate as n, collectSimpleChannelFieldAssignments as o, ChannelAccountSurface as r, getChannelRecord as s, ChannelAccountEntry as t, isBaseFieldActiveForChannelSurface as u };