import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import { c as normalizeAgentId } from "./session-key-BSgfYlBK.js";
import { g as listAgentEntries } from "./agent-scope-CbabgXwH.js";
import { t as resolveAgentRuntimePolicy } from "./agent-runtime-policy-GBXGObpb.js";
import { n as resolveEmbeddedAgentHarnessFallback, t as normalizeEmbeddedAgentRuntime } from "./runtime-CtWi33Py.js";
//#region src/agents/agent-runtime-metadata.ts
function normalizeRuntimeValue(value) {
	const normalized = typeof value === "string" ? normalizeLowercaseStringOrEmpty(value) : "";
	return normalized ? normalizeEmbeddedAgentRuntime(normalized) : void 0;
}
function normalizeAgentHarnessFallback(value, runtime) {
	if (value) return value === "none" ? "none" : "pi";
	return runtime === "auto" ? "pi" : "none";
}
function isPluginAgentRuntime(runtime) {
	return runtime !== "auto" && runtime !== "pi";
}
function resolveEffectiveFallback(params) {
	if (params.envFallback) return params.envFallback;
	if (params.envRuntime && isPluginAgentRuntime(params.runtime)) return normalizeAgentHarnessFallback(void 0, params.runtime);
	if (params.agentPolicy?.id) return normalizeAgentHarnessFallback(params.agentPolicy.fallback, params.runtime);
	if (params.envRuntime || params.defaultsPolicy?.id || params.agentPolicy?.fallback || params.defaultsPolicy?.fallback) return normalizeAgentHarnessFallback(params.agentPolicy?.fallback ?? params.defaultsPolicy?.fallback, params.runtime);
}
function resolveAgentRuntimeMetadata(cfg, agentId, env = process.env) {
	const envFallback = resolveEmbeddedAgentHarnessFallback(env);
	const envRuntime = normalizeRuntimeValue(env.OPENCLAW_AGENT_RUNTIME);
	const normalizedAgentId = normalizeAgentId(agentId);
	const agentPolicy = resolveAgentRuntimePolicy(listAgentEntries(cfg).find((entry) => normalizeAgentId(entry.id) === normalizedAgentId));
	const defaultsPolicy = resolveAgentRuntimePolicy(cfg.agents?.defaults);
	if (envRuntime) return {
		id: envRuntime,
		fallback: resolveEffectiveFallback({
			envFallback,
			envRuntime,
			runtime: envRuntime,
			agentPolicy,
			defaultsPolicy
		}),
		source: "env"
	};
	const agentRuntime = normalizeRuntimeValue(agentPolicy?.id);
	if (agentRuntime) return {
		id: agentRuntime,
		fallback: resolveEffectiveFallback({
			envFallback,
			runtime: agentRuntime,
			agentPolicy,
			defaultsPolicy
		}),
		source: envFallback ? "env" : "agent"
	};
	const defaultsRuntime = normalizeRuntimeValue(defaultsPolicy?.id);
	if (defaultsRuntime) return {
		id: defaultsRuntime,
		fallback: resolveEffectiveFallback({
			envFallback,
			runtime: defaultsRuntime,
			agentPolicy,
			defaultsPolicy
		}),
		source: envFallback ? "env" : agentPolicy?.fallback ? "agent" : "defaults"
	};
	return {
		id: "pi",
		fallback: resolveEffectiveFallback({
			envFallback,
			runtime: "pi",
			agentPolicy,
			defaultsPolicy
		}),
		source: envFallback ? "env" : agentPolicy?.fallback ? "agent" : defaultsPolicy?.fallback ? "defaults" : "implicit"
	};
}
//#endregion
export { resolveAgentRuntimeMetadata as t };
