import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { o as parseAgentSessionKey } from "./session-key-utils-qD-NZHCY.js";
import { c as normalizeAgentId, l as normalizeMainKey } from "./session-key-DFEyR49L.js";
import { c as resolveDefaultAgentId } from "./agent-scope-config-26EcJVc0.js";
import "./agent-scope-C1Fl7gAf.js";
//#region src/agents/pi-embedded-runner/context-engine-capabilities.ts
function resolveBoundAgentId(params) {
	const explicitAgentId = normalizeOptionalString(params.agentId);
	if (explicitAgentId) return normalizeAgentId(explicitAgentId);
	const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
	if (!normalizedSessionKey) return;
	const parsed = parseAgentSessionKey(normalizedSessionKey);
	if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
	const loweredSessionKey = normalizeLowercaseStringOrEmpty(normalizedSessionKey);
	const mainKey = normalizeMainKey(params.config?.session?.mainKey);
	if (loweredSessionKey === "main" || loweredSessionKey === mainKey) return resolveDefaultAgentId(params.config ?? {});
}
/**
* Build host-owned capabilities that are bound to one context-engine runtime call.
*/
function resolveContextEngineCapabilities(params) {
	const sessionKey = normalizeOptionalString(params.sessionKey);
	const agentId = resolveBoundAgentId({
		config: params.config,
		sessionKey,
		agentId: params.agentId
	});
	const contextEnginePluginId = normalizeOptionalString(params.contextEnginePluginId);
	return { llm: { complete: async (request) => {
		const { createRuntimeLlm } = await import("./runtime-llm.runtime.js");
		return await createRuntimeLlm({
			getConfig: () => params.config,
			authority: {
				caller: {
					kind: "context-engine",
					id: params.purpose
				},
				requiresBoundAgent: true,
				...sessionKey ? { sessionKey } : {},
				...agentId ? { agentId } : {},
				...contextEnginePluginId ? { pluginIdForPolicy: contextEnginePluginId } : {},
				allowAgentIdOverride: false,
				allowModelOverride: false,
				allowComplete: true
			}
		}).complete(request);
	} } };
}
//#endregion
export { resolveContextEngineCapabilities as t };
