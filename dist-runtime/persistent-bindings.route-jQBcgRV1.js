import { fp as ensureConfiguredAcpBindingSession, hp as deriveLastRoutePolicy, pp as resolveConfiguredAcpBindingRecord } from "./auth-profiles-DqxBs6Au.js";
import { u as resolveAgentIdFromSessionKey } from "./session-key-D2lHwVVl.js";
//#region src/acp/persistent-bindings.route.ts
function resolveConfiguredAcpRoute(params) {
	const configuredBinding = resolveConfiguredAcpBindingRecord({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!configuredBinding) {return {
		configuredBinding: null,
		route: params.route
	};}
	const boundSessionKey = configuredBinding.record.targetSessionKey?.trim() ?? "";
	if (!boundSessionKey) {return {
		configuredBinding,
		route: params.route
	};}
	const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
	return {
		configuredBinding,
		boundSessionKey,
		boundAgentId,
		route: {
			...params.route,
			sessionKey: boundSessionKey,
			agentId: boundAgentId,
			lastRoutePolicy: deriveLastRoutePolicy({
				sessionKey: boundSessionKey,
				mainSessionKey: params.route.mainSessionKey
			}),
			matchedBy: "binding.channel"
		}
	};
}
async function ensureConfiguredAcpRouteReady(params) {
	if (!params.configuredBinding) {return { ok: true };}
	const ensured = await ensureConfiguredAcpBindingSession({
		cfg: params.cfg,
		spec: params.configuredBinding.spec
	});
	if (ensured.ok) {return { ok: true };}
	return {
		ok: false,
		error: ensured.error ?? "unknown error"
	};
}
//#endregion
export { resolveConfiguredAcpRoute as n, ensureConfiguredAcpRouteReady as t };
