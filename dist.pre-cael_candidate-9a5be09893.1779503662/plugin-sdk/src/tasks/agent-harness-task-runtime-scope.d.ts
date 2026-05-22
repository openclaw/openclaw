import type { DeliveryContext } from "../utils/delivery-context.types.js";
export type AgentHarnessTaskRuntimeScope = {
    readonly requesterSessionKey: string;
    readonly requesterOrigin?: DeliveryContext;
};
export declare function createAgentHarnessTaskRuntimeScope(params: {
    requesterSessionKey: string;
    requesterOrigin?: DeliveryContext;
}): AgentHarnessTaskRuntimeScope;
export declare function assertAgentHarnessTaskRuntimeScope(scope: AgentHarnessTaskRuntimeScope): AgentHarnessTaskRuntimeScope;
