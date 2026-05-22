import type { GroupPolicy } from "../../config/types.base.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
type GroupPolicyWarningCollector = (groupPolicy: GroupPolicy) => string[];
type AccountGroupPolicyWarningCollector<ResolvedAccount> = (params: {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
}) => string[];
type ConfigGroupPolicyWarningCollector<Params extends {
    cfg: OpenClawConfig;
}> = (params: Params) => string[];
type WarningCollector<Params> = (params: Params) => string[];
export declare function composeWarningCollectors<Params>(...collectors: Array<WarningCollector<Params> | null | undefined>): WarningCollector<Params>;
export declare function projectWarningCollector<Params, Projected>(project: (params: Params) => Projected, collector: WarningCollector<Projected>): WarningCollector<Params>;
export declare function projectConfigWarningCollector<Params extends {
    cfg: OpenClawConfig;
}>(collector: WarningCollector<{
    cfg: OpenClawConfig;
}>): WarningCollector<Params>;
export declare function projectConfigAccountIdWarningCollector<Params extends {
    cfg: OpenClawConfig;
    accountId?: string | null;
}>(collector: WarningCollector<{
    cfg: OpenClawConfig;
    accountId?: string | null;
}>): WarningCollector<Params>;
export declare function projectAccountWarningCollector<ResolvedAccount, Params extends {
    account: ResolvedAccount;
}>(collector: WarningCollector<ResolvedAccount>): WarningCollector<Params>;
export declare function projectAccountConfigWarningCollector<ResolvedAccount, ProjectedCfg, Params extends {
    account: ResolvedAccount;
    cfg: OpenClawConfig;
}>(projectCfg: (cfg: OpenClawConfig) => ProjectedCfg, collector: WarningCollector<{
    account: ResolvedAccount;
    cfg: ProjectedCfg;
}>): WarningCollector<Params>;
export declare function createConditionalWarningCollector<Params>(...collectors: Array<(params: Params) => string | string[] | null | undefined | false>): WarningCollector<Params>;
export declare function composeAccountWarningCollectors<ResolvedAccount, Params extends {
    account: ResolvedAccount;
}>(baseCollector: WarningCollector<Params>, ...collectors: Array<(account: ResolvedAccount) => string | string[] | null | undefined | false>): WarningCollector<Params>;
export declare function buildOpenGroupPolicyWarning(params: {
    surface: string;
    openBehavior: string;
    remediation: string;
}): string;
export declare function buildOpenGroupPolicyRestrictSendersWarning(params: {
    surface: string;
    openScope: string;
    groupPolicyPath: string;
    groupAllowFromPath: string;
    mentionGated?: boolean;
}): string;
export declare function buildOpenGroupPolicyNoRouteAllowlistWarning(params: {
    surface: string;
    routeAllowlistPath: string;
    routeScope: string;
    groupPolicyPath: string;
    groupAllowFromPath: string;
    mentionGated?: boolean;
}): string;
export declare function buildOpenGroupPolicyConfigureRouteAllowlistWarning(params: {
    surface: string;
    openScope: string;
    groupPolicyPath: string;
    routeAllowlistPath: string;
    mentionGated?: boolean;
}): string;
export declare function collectOpenGroupPolicyRestrictSendersWarnings(params: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0] & {
    groupPolicy: "open" | "allowlist" | "disabled";
}): string[];
export declare function collectAllowlistProviderRestrictSendersWarnings(params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
} & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">): string[];
/** Build an account-aware allowlist-provider warning collector for sender-restricted groups. */
export declare function createAllowlistProviderRestrictSendersWarningCollector<ResolvedAccount>(params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
} & Omit<Parameters<typeof collectAllowlistProviderRestrictSendersWarnings>[0], "cfg" | "providerConfigPresent" | "configuredGroupPolicy">): AccountGroupPolicyWarningCollector<ResolvedAccount>;
/** Build a direct account-aware warning collector when the policy already lives on the account. */
export declare function createOpenGroupPolicyRestrictSendersWarningCollector<ResolvedAccount>(params: {
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
    defaultGroupPolicy?: GroupPolicy;
} & Omit<Parameters<typeof collectOpenGroupPolicyRestrictSendersWarnings>[0], "groupPolicy">): (account: ResolvedAccount) => string[];
export declare function collectAllowlistProviderGroupPolicyWarnings(params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
    collect: GroupPolicyWarningCollector;
}): string[];
/** Build a config-aware allowlist-provider warning collector from an arbitrary policy resolver. */
export declare function createAllowlistProviderGroupPolicyWarningCollector<Params extends {
    cfg: OpenClawConfig;
}>(params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
    collect: (params: Params & {
        groupPolicy: GroupPolicy;
    }) => string[];
}): ConfigGroupPolicyWarningCollector<Params>;
export declare function collectOpenProviderGroupPolicyWarnings(params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
    collect: GroupPolicyWarningCollector;
}): string[];
/** Build a config-aware open-provider warning collector from an arbitrary policy resolver. */
export declare function createOpenProviderGroupPolicyWarningCollector<Params extends {
    cfg: OpenClawConfig;
}>(params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (params: Params) => GroupPolicy | null | undefined;
    collect: (params: Params & {
        groupPolicy: GroupPolicy;
    }) => string[];
}): ConfigGroupPolicyWarningCollector<Params>;
/** Build an account-aware allowlist-provider warning collector for simple open-policy warnings. */
export declare function createAllowlistProviderOpenWarningCollector<ResolvedAccount>(params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
    buildOpenWarning: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount>;
export declare function collectOpenGroupPolicyRouteAllowlistWarnings(params: {
    groupPolicy: "open" | "allowlist" | "disabled";
    routeAllowlistConfigured: boolean;
    restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
    noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): string[];
/** Build an account-aware allowlist-provider warning collector for route-allowlisted groups. */
export declare function createAllowlistProviderRouteAllowlistWarningCollector<ResolvedAccount>(params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
    resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
    restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
    noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount>;
export declare function collectOpenGroupPolicyConfiguredRouteWarnings(params: {
    groupPolicy: "open" | "allowlist" | "disabled";
    routeAllowlistConfigured: boolean;
    configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
    missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): string[];
/** Build an account-aware open-provider warning collector for configured-route channels. */
export declare function createOpenProviderConfiguredRouteWarningCollector<ResolvedAccount>(params: {
    providerConfigPresent: (cfg: OpenClawConfig) => boolean;
    resolveGroupPolicy: (account: ResolvedAccount) => GroupPolicy | null | undefined;
    resolveRouteAllowlistConfigured: (account: ResolvedAccount) => boolean;
    configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
    missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): AccountGroupPolicyWarningCollector<ResolvedAccount>;
export {};
