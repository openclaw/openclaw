import { getGlobalHookRunner } from "../../plugins/hook-runner-global.js";
import type { PluginHookAgentEndEvent, PluginHookBeforeAgentFinalizeEvent, PluginHookLlmInputEvent, PluginHookLlmOutputEvent } from "../../plugins/hook-types.js";
import { type AgentHarnessHookContext } from "./hook-context.js";
type AgentHarnessHookRunner = ReturnType<typeof getGlobalHookRunner>;
export declare function runAgentHarnessLlmInputHook(params: {
    event: PluginHookLlmInputEvent;
    ctx: AgentHarnessHookContext;
    hookRunner?: AgentHarnessHookRunner;
}): void;
export declare function runAgentHarnessLlmOutputHook(params: {
    event: PluginHookLlmOutputEvent;
    ctx: AgentHarnessHookContext;
    hookRunner?: AgentHarnessHookRunner;
}): void;
export declare function runAgentHarnessAgentEndHook(params: {
    event: PluginHookAgentEndEvent;
    ctx: AgentHarnessHookContext;
    hookRunner?: AgentHarnessHookRunner;
}): void;
export type AgentHarnessBeforeAgentFinalizeOutcome = {
    action: "continue";
} | {
    action: "revise";
    reason: string;
} | {
    action: "finalize";
    reason?: string;
};
export declare function runAgentHarnessBeforeAgentFinalizeHook(params: {
    event: PluginHookBeforeAgentFinalizeEvent;
    ctx: AgentHarnessHookContext;
    hookRunner?: AgentHarnessHookRunner;
}): Promise<AgentHarnessBeforeAgentFinalizeOutcome>;
export {};
