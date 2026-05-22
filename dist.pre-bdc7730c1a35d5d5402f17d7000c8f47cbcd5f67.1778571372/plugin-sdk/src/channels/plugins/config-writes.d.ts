import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { type ConfigWriteAuthorizationResultLike, type ConfigWriteScopeLike, type ConfigWriteTargetLike } from "./config-write-policy-shared.js";
import type { ChannelId } from "./types.core.js";
export type ConfigWriteScope = ConfigWriteScopeLike;
export type ConfigWriteTarget = ConfigWriteTargetLike;
export type ConfigWriteAuthorizationResult = ConfigWriteAuthorizationResultLike;
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
