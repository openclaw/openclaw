import type { PluginRuntimeTaskFlow } from "./runtime-taskflow.types.js";
import type { PluginRuntimeTaskFlows, PluginRuntimeTaskRuns, PluginRuntimeTasks } from "./runtime-tasks.types.js";
export type { BoundTaskFlowsRuntime, BoundTaskRunsRuntime, PluginRuntimeTaskFlows, PluginRuntimeTaskRuns, PluginRuntimeTasks, } from "./runtime-tasks.types.js";
export declare function createRuntimeTaskRuns(): PluginRuntimeTaskRuns;
export declare function createRuntimeTaskFlows(): PluginRuntimeTaskFlows;
export declare function createRuntimeTasks(params: {
    legacyTaskFlow: PluginRuntimeTaskFlow;
}): PluginRuntimeTasks;
