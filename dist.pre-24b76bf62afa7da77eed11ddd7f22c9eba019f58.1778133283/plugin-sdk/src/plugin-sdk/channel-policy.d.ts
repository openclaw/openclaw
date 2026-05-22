import { createAllowlistProviderRestrictSendersWarningCollector } from "../channels/plugins/group-policy-warnings.js";
import type { ChannelSecurityAdapter } from "../channels/plugins/types.adapters.js";
import type { GroupPolicy } from "../config/types.base.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
/** Shared policy warnings and DM/group policy helpers for channel plugins. */
export type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig, } from "../config/types.tools.js";
export { composeAccountWarningCollectors, buildOpenGroupPolicyConfigureRouteAllowlistWarning, composeWarningCollectors, createAllowlistProviderGroupPolicyWarningCollector, createConditionalWarningCollector, createAllowlistProviderOpenWarningCollector, createAllowlistProviderRouteAllowlistWarningCollector, createOpenGroupPolicyRestrictSendersWarningCollector, createOpenProviderGroupPolicyWarningCollector, createOpenProviderConfiguredRouteWarningCollector, buildOpenGroupPolicyRestrictSendersWarning, buildOpenGroupPolicyWarning, collectAllowlistProviderGroupPolicyWarnings, collectAllowlistProviderRestrictSendersWarnings, collectOpenGroupPolicyConfiguredRouteWarnings, collectOpenGroupPolicyRestrictSendersWarnings, collectOpenGroupPolicyRouteAllowlistWarnings, collectOpenProviderGroupPolicyWarnings, projectAccountConfigWarningCollector, projectAccountWarningCollector, projectConfigAccountIdWarningCollector, projectConfigWarningCollector, projectWarningCollector, } from "../channels/plugins/group-policy-warnings.js";
export { buildAccountScopedDmSecurityPolicy } from "../channels/plugins/helpers.js";
export { resolveChannelGroupPolicy, resolveChannelGroupRequireMention, resolveChannelGroupToolsPolicy, resolveToolsBySender, type ChannelGroupPolicy, } from "../config/group-policy.js";
export { DM_GROUP_ACCESS_REASON, readStoreAllowFromForDmPolicy, resolveDmGroupAccessWithCommandGate, resolveDmGroupAccessWithLists, resolveEffectiveAllowFromLists, resolveOpenDmAllowlistAccess, } from "../security/dm-policy-shared.js";
export { evaluateGroupRouteAccessForPolicy, evaluateSenderGroupAccessForPolicy, resolveSenderScopedGroupPolicy, } from "./group-access.js";
export { createAllowlistProviderRestrictSendersWarningCollector };
export declare function normalizeAllowFromList(list: Array<string | number> | undefined | null): string[];
export declare function coerceNativeSetting(value: unknown): boolean | "auto" | undefined;
export type ChannelMutableAllowlistCandidate = {
    pathLabel: string;
    list: unknown;
};
export declare function createDangerousNameMatchingMutableAllowlistWarningCollector(params: {
    channel: string;
    detector: (entry: string) => boolean;
    collectLists: (scope: {
        prefix: string;
        account: Record<string, unknown>;
        dangerousFlagPath: string;
    }) => ChannelMutableAllowlistCandidate[];
}): ({ cfg }: {
    cfg: OpenClawConfig;
}) => string[];
/** Compose the common DM policy resolver with restrict-senders group warnings. */
export declare function createRestrictSendersChannelSecurity<ResolvedAccount extends {
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
