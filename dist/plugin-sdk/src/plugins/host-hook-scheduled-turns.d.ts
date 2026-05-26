import type { CronServiceContract } from "../cron/service-contract.js";
import type { PluginSessionSchedulerJobHandle, PluginSessionTurnScheduleParams, PluginSessionTurnUnscheduleByTagParams, PluginSessionTurnUnscheduleByTagResult } from "./host-hooks.js";
import type { PluginOrigin } from "./plugin-origin.types.js";
import type { PluginRegistry } from "./registry-types.js";
export declare function buildPluginSchedulerCronName(params: {
    pluginId: string;
    sessionKey: string;
    tag?: string;
    uniqueId?: string;
}): string;
export declare function schedulePluginSessionTurn(params: {
    pluginId: string;
    pluginName?: string;
    origin?: PluginOrigin;
    schedule: PluginSessionTurnScheduleParams;
    shouldCommit?: () => boolean;
    cron?: CronServiceContract;
    ownerRegistry?: PluginRegistry;
}): Promise<PluginSessionSchedulerJobHandle | undefined>;
export declare function unschedulePluginSessionTurnsByTag(params: {
    pluginId: string;
    origin?: PluginOrigin;
    cron?: CronServiceContract;
    request: PluginSessionTurnUnscheduleByTagParams;
}): Promise<PluginSessionTurnUnscheduleByTagResult>;
