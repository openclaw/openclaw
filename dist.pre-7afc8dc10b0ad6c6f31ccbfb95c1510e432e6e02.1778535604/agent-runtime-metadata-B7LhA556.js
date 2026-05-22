import { t as resolveModelRuntimePolicy } from "./model-runtime-policy-4lNwKpNk.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime-BsEyeI_y.js";
import { a as openAIProviderUsesCodexRuntimeByDefault, n as isOpenAICodexProvider } from "./openai-codex-routing-Tk9OL05P.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-DmMcdmk8.js";
//#region src/agents/harness/policy.ts
function resolveAgentHarnessPolicy(params) {
	const configured = resolveModelRuntimePolicy({
		config: params.config,
		provider: params.provider,
		modelId: params.modelId,
		agentId: params.agentId,
		sessionKey: params.sessionKey
	});
	const configuredRuntime = configured.policy?.id?.trim();
	const runtimeSource = configured.source ?? "implicit";
	const runtime = configuredRuntime && configuredRuntime !== "default" ? normalizeEmbeddedAgentRuntime(configuredRuntime) : "auto";
	if (openAIProviderUsesCodexRuntimeByDefault({
		provider: params.provider,
		config: params.config
	})) {
		if (runtime === "auto") return {
			runtime: "codex",
			runtimeSource
		};
		return {
			runtime,
			runtimeSource
		};
	}
	if (isOpenAICodexProvider(params.provider)) {
		if (runtime === "auto") return {
			runtime: "codex",
			runtimeSource
		};
		return {
			runtime,
			runtimeSource
		};
	}
	return {
		runtime,
		runtimeSource
	};
}
//#endregion
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
export { resolveAgentHarnessPolicy as n, resolveModelAgentRuntimeMetadata as t };
