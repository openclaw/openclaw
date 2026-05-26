import { t as resolveModelRuntimePolicy } from "./model-runtime-policy-CAe5ww09.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime-fVbSwiLb.js";
import { r as isOpenAICodexProvider, s as openAIProviderUsesCodexRuntimeByDefault } from "./openai-codex-routing-DwRY-_VI.js";
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
export { resolveAgentHarnessPolicy as t };
