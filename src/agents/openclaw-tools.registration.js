import { isStrictAgenticExecutionContractActive } from "./execution-contract.js";
export function collectPresentOpenClawTools(candidates) {
    return candidates.filter((tool) => tool !== null && tool !== undefined);
}
export function isUpdatePlanToolEnabledForOpenClawTools(params) {
    const configured = params.config?.tools?.experimental?.planTool;
    if (configured !== undefined) {
        return configured;
    }
    return isStrictAgenticExecutionContractActive({
        config: params.config,
        sessionKey: params.agentSessionKey,
        agentId: params.agentId,
        provider: params.modelProvider,
        modelId: params.modelId,
    });
}
