import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { _ as GroupPolicy } from "./types.base-DS--yneR.js";
import { V as ChannelSecurityAdapter } from "./types.adapters-y0dBEomF.js";
//#region src/channels/plugins/group-policy-warnings.d.ts
type GroupPolicyWarningCollector = (groupPolicy: GroupPolicy) => string[];
type AccountGroupPolicyWarningCollector<ResolvedAccount> = (params: {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
}) => string[];
type ConfigGroupPolicyWarningCollector<Params extends {
  cfg: OpenClawConfig;
}> = (params: Params) => string[];
type WarningCollector<Params> = (params: Params) => string[];
declare function composeWarningCollectors<Params>(...collectors: Array<WarningCollector<Params> | null | undefined>): WarningCollector<Params>;
declare function projectWarningCollector<Params, Projected>(project: (params: Params) => Projected, collector: WarningCollector<Projected>): WarningCollector<Params>;
declare function projectConfigWarningCollector<Params extends {
  cfg: OpenClawConfig;
}>(collector: WarningCollector<{
  cfg: OpenClawConfig;
}>): WarningCollector<Params>;
declare function projectConfigAccountIdWarningCollector<Params extends {
  cfg: OpenClawConfig;
  accountId?: string | null;
}>(collector: WarningCollector<{
  cfg: OpenClawConfig;
  accountId?: string | null;
}>): WarningCollector<Params>;
declare function projectAccountWarningCollector<ResolvedAccount, Params extends {
  account: ResolvedAccount;
}>(collector: WarningCollector<ResolvedAccount>): WarningCollector<Params>;
declare function projectAccountConfigWarningCollector<ResolvedAccount, ProjectedCfg, Params extends {
  account: ResolvedAccount;
  cfg: OpenClawConfig;
}>(projectCfg: (cfg: OpenClawConfig) => ProjectedCfg, collector: WarningCollector<{
  account: ResolvedAccount;
  cfg: ProjectedCfg;
}>): WarningCollector<Params>;
declare function createConditionalWarningCollector<Params>(...collectors: Array<(params: Params) => string | string[] | null | undefined | false>): WarningCollector<Params>;
declare function composeAccountWarningCollectors<ResolvedAccount, Params extends {
  account: ResolvedAccount;
}>(baseCollector: WarningCollector<Params>, ...collectors: Array<(account: ResolvedAccount) => string | string[] | null | undefined | false>): WarningCollector<Params>;
declare function buildOpenGroupPolicyWarning(params: {
  surface: string;
  openBehavior: string;
  remediation: string;
}): string;
declare function buildOpenGroupPolicyRestrictSendersWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string;
declare function buildOpenGroupPolicyNoRouteAllowlistWarning(params: {
  surface: string;
  routeAllowlistPath: string;
  routeScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
}): string;
declare function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params: {
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  routeAllowlistPath: string;
  mentionGated?: boolean;
}): string;
declare function collectOpenGroupPolicyRestrictSendersWarnings(params: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0] & {
  groupPolicy: "open" | "allowlist" | "disabled";
}): string[];
declare function collectAllowlistProviderRestrictSendersWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
} & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">): string[];
/** Build an account-aware allowlist-provider warning collector for sender-restricted groups. */
declare function createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
} & Omit<Parameters<typeof collectAllowlistProviderRestrictSendersWarnings>[0], "cfg" | "providerConfigPresent" | "configuredGroupPolicy">): AccountGroupPolicyWarningCollector<ResolvedAccount>;
/** Build a direct account-aware warning collector when the policy already lives on the account. */
declare function createOpenGroupPolicyRestrictSendersWarningCollector<ResolvedAccount>(params: {
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  defaultGroupPolicy?: GroupPolicy;
} & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">): (account: ResolvedAccount) => string[];
declare function collectAllowlistProviderGroupPolicyWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
  collect: GroupPolicyWarningCollector;
}): string[];
/** Build a config-aware allowlist-provider warning collector from an arbitrary policy resolver. */
declare function createAllowlistProviderGroupPolicyWarningCollector<Params extends {
  cfg: OpenClawConfig;
}>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
  collect: (params: Params & {
    groupPolicy: GroupPolicy;
  }) => string[];
}): ConfigGroupPolicyWarningCollector<Params>;
declare function collectOpenProviderGroupPolicyWarnings(params: {
  cfg: OpenClawConfig;
  providerConfigPresent: boolean;
  configuredGroupPolicy?: GroupPolicy | null;
  collect: GroupPolicyWarningCollector;
}): string[];
/** Build a config-aware open-provider warning collector from an arbitrary policy resolver. */
declare function createOpenProviderGroupPolicyWarningCollector<Params extends {
  cfg: OpenClawConfig;
}>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
  collect: (params: Params & {
    groupPolicy: GroupPolicy;
  }) => string[];
}): ConfigGroupPolicyWarningCollector<Params>;
/** Build an account-aware allowlist-provider warning collector for simple open-policy warnings. */
declare function createAllowlistProviderOpenWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  buildOpenWarning: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount>;
declare function collectOpenGroupPolicyRouteAllowlistWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): string[];
/** Build an account-aware allowlist-provider warning collector for route-allowlisted groups. */
declare function createAllowlistProviderRouteAllowlistWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
  restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
  noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount>;
declare function collectOpenGroupPolicyConfiguredRouteWarnings(params: {
  groupPolicy: "open" | "allowlist" | "disabled";
  routeAllowlistConfigured: boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): string[];
/** Build an account-aware open-provider warning collector for configured-route channels. */
declare function createOpenProviderConfiguredRouteWarningCollector<ResolvedAccount>(params: {
  providerConfigPresent: (cfg: OpenClawConfig) => boolean;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
  configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
  missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount>;
//#endregion
//#region src/plugin-sdk/channel-policy.d.ts
declare function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[];
declare function coerceNativeSetting(value: unknown): boolean | "auto" | undefined;
type ChannelMutableAllowlistCandidate = {
  pathLabel: string;
  list: unknown;
};
declare function createDangerousNameMatchingMutableAllowlistWarningCollector(params: {
  channel: string;
  detector: (entry: string) => boolean;
  collectLists: (scope: {
    prefix: string;
    account: Record<string, unknown>;
    dangerousFlagPath: string;
  }) => ChannelMutableAllowlistCandidate[];
}): ({
  cfg
}: {
  cfg: OpenClawConfig;
}) => string[];
/** Compose the common DM policy resolver with restrict-senders group warnings. */
declare function createRestrictSendersChannelSecurity<ResolvedAccount extends {
  accountId?: string | null;
}>(params: {
  channelKey: string;
  resolveDmPolicy: (account: ResolvedAccount) => string | null | undefined;
  resolveDmAllowFrom: (account: ResolvedAccount) => Array<string | number> | null | undefined;
  resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
  surface: string;
  openScope: string;
  groupPolicyPath: string;
  groupAllowFromPath: string;
  mentionGated?: boolean;
  providerConfigPresent?: (cfg: OpenClawConfig) => boolean;
  resolveFallbackAccountId?: (account: ResolvedAccount) => string | null | undefined;
  defaultDmPolicy?: string;
  allowFromPathSuffix?: string;
  policyPathSuffix?: string;
  approveChannelId?: string;
  approveHint?: string;
  normalizeDmEntry?: (raw: string) => string;
  inheritSharedDefaultsFromDefaultAccount?: boolean;
}): ChannelSecurityAdapter<ResolvedAccount>;
//#endregion
export { createOpenProviderConfiguredRouteWarningCollector as C, projectConfigAccountIdWarningCollector as D, projectAccountWarningCollector as E, projectConfigWarningCollector as O, createOpenGroupPolicyRestrictSendersWarningCollector as S, projectAccountConfigWarningCollector as T, createAllowlistProviderGroupPolicyWarningCollector as _, normalizeAllowFromList as a, createAllowlistProviderRouteAllowlistWarningCollector as b, buildOpenGroupPolicyWarning as c, collectOpenGroupPolicyConfiguredRouteWarnings as d, collectOpenGroupPolicyRestrictSendersWarnings as f, composeWarningCollectors as g, composeAccountWarningCollectors as h, createRestrictSendersChannelSecurity as i, projectWarningCollector as k, collectAllowlistProviderGroupPolicyWarnings as l, collectOpenProviderGroupPolicyWarnings as m, coerceNativeSetting as n, buildOpenGroupPolicyConfigureRouteAllowlistWarning as o, collectOpenGroupPolicyRouteAllowlistWarnings as p, createDangerousNameMatchingMutableAllowlistWarningCollector as r, buildOpenGroupPolicyRestrictSendersWarning as s, ChannelMutableAllowlistCandidate as t, collectAllowlistProviderRestrictSendersWarnings as u, createAllowlistProviderOpenWarningCollector as v, createOpenProviderGroupPolicyWarningCollector as w, createConditionalWarningCollector as x, createAllowlistProviderRestrictSendersWarningCollector as y };