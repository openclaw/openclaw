import { d as resolveAgentIdFromSessionKey, s as init_session_key } from "./session-key-BSZsryCD.js";
import { n as deriveLastRoutePolicy } from "./resolve-route-CQsiaDZO.js";
import { Os as ensureConfiguredAcpBindingSession, ks as resolveConfiguredAcpBindingRecord } from "./auth-profiles-B70DPAVa.js";
//#region src/acp/persistent-bindings.route.ts
init_session_key();
function resolveConfiguredAcpRoute(params) {
	const configuredBinding = resolveConfiguredAcpBindingRecord({
		cfg: params.cfg,
		channel: params.channel,
		accountId: params.accountId,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	});
	if (!configuredBinding) return {
		configuredBinding: null,
		route: params.route
	};
	const boundSessionKey = configuredBinding.record.targetSessionKey?.trim() ?? "";
	if (!boundSessionKey) return {
		configuredBinding,
		route: params.route
	};
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
	if (!params.configuredBinding) return { ok: true };
	const ensured = await ensureConfiguredAcpBindingSession({
		cfg: params.cfg,
		spec: params.configuredBinding.spec
	});
	if (ensured.ok) return { ok: true };
	return {
		ok: false,
		error: ensured.error ?? "unknown error"
	};
}
//#endregion
export { resolveConfiguredAcpRoute as n, ensureConfiguredAcpRouteReady as t };
