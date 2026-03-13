import type { OpenClawConfig } from "../../config/config.js";
import type { ChannelId } from "./types.js";
export type ConfigWriteScope = {
    channelId?: ChannelId | null;
    accountId?: string | null;
};
export type ConfigWriteTarget = {
    kind: "global";
} | {
    kind: "channel";
    scope: {
        channelId: ChannelId;
    };
} | {
    kind: "account";
    scope: {
        channelId: ChannelId;
        accountId: string;
    };
} | {
    kind: "ambiguous";
    scopes: ConfigWriteScope[];
};
export type ConfigWriteAuthorizationResult = {
    allowed: true;
} | {
    allowed: false;
    reason: "ambiguous-target" | "origin-disabled" | "target-disabled";
    blockedScope?: {
        kind: "origin" | "target";
        scope: ConfigWriteScope;
    };
};
export declare function resolveChannelConfigWrites(params: {
    cfg: OpenClawConfig;
    channelId?: ChannelId | null;
    accountId?: string | null;
}): boolean;
export declare function authorizeConfigWrite(params: {
    cfg: OpenClawConfig;
    origin?: ConfigWriteScope;
    target?: ConfigWriteTarget;
    allowBypass?: boolean;
}): ConfigWriteAuthorizationResult;
export declare function resolveExplicitConfigWriteTarget(scope: ConfigWriteScope): ConfigWriteTarget;
export declare function resolveConfigWriteTargetFromPath(path: string[]): ConfigWriteTarget;
export declare function canBypassConfigWritePolicy(params: {
    channel?: string | null;
    gatewayClientScopes?: string[] | null;
}): boolean;
export declare function formatConfigWriteDeniedMessage(params: {
    result: Exclude<ConfigWriteAuthorizationResult, {
        allowed: true;
    }>;
    fallbackChannelId?: ChannelId | null;
}): string;
