import type { OpenClawConfig } from "../../config/config.js";
import type { GroupPolicy } from "../../config/types.base.js";
type GroupPolicyWarningCollector = (groupPolicy: GroupPolicy) => string[];
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
export declare function collectAllowlistProviderGroupPolicyWarnings(params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
    collect: GroupPolicyWarningCollector;
}): string[];
export declare function collectOpenProviderGroupPolicyWarnings(params: {
    cfg: OpenClawConfig;
    providerConfigPresent: boolean;
    configuredGroupPolicy?: GroupPolicy | null;
    collect: GroupPolicyWarningCollector;
}): string[];
export declare function collectOpenGroupPolicyRouteAllowlistWarnings(params: {
    groupPolicy: "open" | "allowlist" | "disabled";
    routeAllowlistConfigured: boolean;
    restrictSenders: Parameters<typeof buildOpenGroupPolicyRestrictSendersWarning>[0];
    noRouteAllowlist: Parameters<typeof buildOpenGroupPolicyNoRouteAllowlistWarning>[0];
}): string[];
export declare function collectOpenGroupPolicyConfiguredRouteWarnings(params: {
    groupPolicy: "open" | "allowlist" | "disabled";
    routeAllowlistConfigured: boolean;
    configureRouteAllowlist: Parameters<typeof buildOpenGroupPolicyConfigureRouteAllowlistWarning>[0];
    missingRouteAllowlist: Parameters<typeof buildOpenGroupPolicyWarning>[0];
}): string[];
export {};
