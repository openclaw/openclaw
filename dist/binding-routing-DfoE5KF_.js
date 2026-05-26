import { r as isCronRunSessionKey } from "./session-key-utils-Ce_xWkNq.js";
import { d as resolveAgentIdFromSessionKey } from "./session-key-Bte0mmcq.js";
import { r as logVerbose } from "./globals-YU5FjfZK.js";
import { n as getSessionBindingService } from "./session-binding-service-B19FMAqz.js";
import { n as deriveLastRoutePolicy } from "./resolve-route-C8IahAyG.js";
import { n as resolveConfiguredBinding } from "./binding-registry-dyeOsusx.js";
import { t as ensureConfiguredBindingTargetReady } from "./binding-targets-DimW-OV5.js";
//#region src/channels/plugins/binding-routing.ts
const CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS = 3e4;
function resolveConfiguredBindingConversationRef(params) {
	if ("conversation" in params) return params.conversation;
	return {
		channel: params.channel,
		accountId: params.accountId,
		conversationId: params.conversationId,
		parentConversationId: params.parentConversationId
	};
}
function isPluginOwnedRuntimeBindingRecord(record) {
	const metadata = record?.metadata;
	if (!metadata || typeof metadata !== "object") return false;
	return metadata.pluginBindingOwner === "plugin" && typeof metadata.pluginId === "string" && typeof metadata.pluginRoot === "string";
}
function resolveConfiguredBindingRoute(params) {
	const bindingResolution = resolveConfiguredBinding({
		cfg: params.cfg,
		conversation: resolveConfiguredBindingConversationRef(params)
	}) ?? null;
	if (!bindingResolution) return {
		bindingResolution: null,
		route: params.route
	};
	const boundSessionKey = bindingResolution.statefulTarget.sessionKey.trim();
	if (!boundSessionKey) return {
		bindingResolution,
		route: params.route
	};
	const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || bindingResolution.statefulTarget.agentId;
	return {
		bindingResolution,
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
function resolveRuntimeConversationBindingRoute(params) {
	const bindingRecord = getSessionBindingService().resolveByConversation(resolveConfiguredBindingConversationRef(params));
	const boundSessionKey = bindingRecord?.targetSessionKey?.trim();
	if (!bindingRecord || !boundSessionKey) return {
		bindingRecord: null,
		route: params.route
	};
	if (isCronRunSessionKey(boundSessionKey)) {
		logVerbose(`ignored runtime conversation binding ${bindingRecord.bindingId} to isolated cron run session ${boundSessionKey}`);
		return {
			bindingRecord: null,
			route: params.route
		};
	}
	getSessionBindingService().touch(bindingRecord.bindingId);
	if (isPluginOwnedRuntimeBindingRecord(bindingRecord)) return {
		bindingRecord,
		route: params.route
	};
	const boundAgentId = resolveAgentIdFromSessionKey(boundSessionKey) || params.route.agentId;
	return {
		bindingRecord,
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
async function ensureConfiguredBindingRouteReady(params) {
	const readyPromise = ensureConfiguredBindingTargetReady(params);
	let timer;
	const timeoutToken = Symbol("configured-binding-route-ready-timeout");
	const timeoutPromise = new Promise((resolve) => {
		timer = setTimeout(() => resolve(timeoutToken), CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS);
		timer.unref?.();
	});
	try {
		const result = await Promise.race([readyPromise, timeoutPromise]);
		if (result !== timeoutToken) return result;
		logVerbose(`configured binding route ready check timed out after ${CONFIGURED_BINDING_ROUTE_READY_TIMEOUT_MS / 1e3}s`);
		readyPromise.then((lateResult) => logVerbose(`configured binding route ready check settled after timeout (ok=${lateResult.ok})`), (err) => logVerbose(`configured binding route ready check rejected after timeout: ${String(err)}`));
		return {
			ok: false,
			error: "Configured binding route ready check timed out"
		};
	} finally {
		clearTimeout(timer);
	}
}
//#endregion
export { resolveConfiguredBindingRoute as n, resolveRuntimeConversationBindingRoute as r, ensureConfiguredBindingRouteReady as t };
