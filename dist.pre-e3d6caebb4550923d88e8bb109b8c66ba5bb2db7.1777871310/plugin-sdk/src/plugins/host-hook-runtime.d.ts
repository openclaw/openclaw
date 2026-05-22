import type { AgentEventPayload } from "../infra/agent-events.js";
import { type PluginHostCleanupReason, type PluginJsonValue, type PluginRunContextGetParams, type PluginRunContextPatch, type PluginSessionSchedulerJobHandle, type PluginSessionSchedulerJobRegistration } from "./host-hooks.js";
import type { PluginRegistry } from "./registry-types.js";
export declare function setPluginRunContext(params: {
    pluginId: string;
    patch: PluginRunContextPatch;
}): boolean;
export declare function getPluginRunContext<T extends PluginJsonValue = PluginJsonValue>(params: {
    pluginId: string;
    get: PluginRunContextGetParams;
}): T | undefined;
export declare function clearPluginRunContext(params: {
    pluginId?: string;
    runId?: string;
    namespace?: string;
}): void;
export declare function dispatchPluginAgentEventSubscriptions(params: {
    registry: PluginRegistry | null | undefined;
    event: AgentEventPayload;
}): void;
export declare function registerPluginSessionSchedulerJob(params: {
    pluginId: string;
    pluginName?: string;
    job: PluginSessionSchedulerJobRegistration;
}): PluginSessionSchedulerJobHandle | undefined;
export declare function getPluginSessionSchedulerJobGeneration(params: {
    pluginId: string;
    jobId: string;
    sessionKey?: string;
}): number | undefined;
export declare function cleanupPluginSessionSchedulerJobs(params: {
    pluginId?: string;
    reason: PluginHostCleanupReason;
    sessionKey?: string;
    records?: readonly {
        pluginId: string;
        pluginName?: string;
        job: PluginSessionSchedulerJobRegistration;
        generation?: number;
    }[];
    preserveJobIds?: ReadonlySet<string>;
}): Promise<Array<{
    pluginId: string;
    hookId: string;
    error: unknown;
}>>;
export declare function clearPluginHostRuntimeState(params?: {
    pluginId?: string;
    runId?: string;
}): void;
export declare function listPluginSessionSchedulerJobs(pluginId?: string): PluginSessionSchedulerJobHandle[];
