import { s as resolveDefaultModelForAgent } from "./model-selection-OBfqg2ku.js";
import { t as resolveAgentHarnessPolicy } from "./policy-rAUF-L6V.js";
//#region src/agents/agent-runtime-metadata.ts
function resolveModelAgentRuntimeMetadata(params) {
	const resolved = params.provider && params.model ? {
		provider: params.provider,
		model: params.model
	} : resolveDefaultModelForAgent({
		cfg: params.cfg,
		agentId: params.agentId
	});
	const policy = resolveAgentHarnessPolicy({
		provider: resolved.provider,
		modelId: resolved.model,
		config: params.cfg,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	return {
		id: policy.runtime,
		source: policy.runtimeSource ?? "implicit"
	};
}
//#endregion
export { resolveModelAgentRuntimeMetadata as t };
