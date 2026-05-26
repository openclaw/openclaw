import { r as getPluginRegistryState } from "./runtime-state-Br1Hd8D7.js";
import { n as resolveReservedGatewayMethodScope } from "./gateway-method-policy-wkwYae2r.js";
import { a as TALK_SECRETS_SCOPE, i as READ_SCOPE, n as APPROVALS_SCOPE, o as WRITE_SCOPE, r as PAIRING_SCOPE, s as isOperatorScope, t as ADMIN_SCOPE } from "./operator-scopes-CpnZaPqz.js";
//#region src/gateway/method-scopes.ts
const CLI_DEFAULT_OPERATOR_SCOPES = [
	ADMIN_SCOPE,
	READ_SCOPE,
	WRITE_SCOPE,
	APPROVALS_SCOPE,
	PAIRING_SCOPE,
	TALK_SECRETS_SCOPE
];
const NODE_ROLE_METHODS = new Set([
	"node.invoke.result",
	"node.event",
	"node.pluginSurface.refresh",
	"node.pending.drain",
	"node.pending.pull",
	"node.pending.ack",
	"skills.bins"
]);
const DYNAMIC_OPERATOR_SCOPE_METHODS = new Set(["plugins.sessionAction"]);
const METHOD_SCOPE_BY_NAME = new Map(Object.entries({
	[APPROVALS_SCOPE]: [
		"exec.approval.get",
		"exec.approval.list",
		"exec.approval.request",
		"exec.approval.waitDecision",
		"exec.approval.resolve",
		"plugin.approval.list",
		"plugin.approval.request",
		"plugin.approval.waitDecision",
		"plugin.approval.resolve"
	],
	[PAIRING_SCOPE]: [
		"node.pair.request",
		"node.pair.list",
		"node.pair.reject",
		"node.pair.remove",
		"node.pair.verify",
		"node.pair.approve",
		"device.pair.list",
		"device.pair.approve",
		"device.pair.reject",
		"device.pair.remove",
		"device.token.rotate",
		"device.token.revoke",
		"node.rename"
	],
	[READ_SCOPE]: [
		"assistant.media.get",
		"health",
		"diagnostics.stability",
		"doctor.memory.status",
		"doctor.memory.dreamDiary",
		"doctor.memory.remHarness",
		"logs.tail",
		"channels.status",
		"status",
		"usage.status",
		"usage.cost",
		"tts.status",
		"tts.providers",
		"tts.personas",
		"commands.list",
		"models.list",
		"models.authStatus",
		"tools.catalog",
		"tools.effective",
		"tasks.list",
		"tasks.get",
		"plugins.uiDescriptors",
		"agents.list",
		"agent.identity.get",
		"skills.status",
		"skills.search",
		"skills.detail",
		"voicewake.get",
		"voicewake.routing.get",
		"sessions.list",
		"sessions.get",
		"sessions.preview",
		"sessions.describe",
		"sessions.resolve",
		"sessions.compaction.list",
		"sessions.compaction.get",
		"sessions.subscribe",
		"sessions.unsubscribe",
		"sessions.messages.subscribe",
		"sessions.messages.unsubscribe",
		"sessions.usage",
		"sessions.usage.timeseries",
		"sessions.usage.logs",
		"cron.get",
		"cron.list",
		"cron.status",
		"cron.runs",
		"gateway.identity.get",
		"gateway.restart.preflight",
		"system-presence",
		"last-heartbeat",
		"node.list",
		"node.describe",
		"environments.list",
		"environments.status",
		"chat.history",
		"config.get",
		"config.schema.lookup",
		"talk.catalog",
		"talk.config",
		"agents.files.list",
		"agents.files.get",
		"artifacts.list",
		"artifacts.get",
		"artifacts.download"
	],
	[WRITE_SCOPE]: [
		"message.action",
		"send",
		"poll",
		"agent",
		"agent.wait",
		"wake",
		"talk.mode",
		"talk.client.create",
		"talk.client.toolCall",
		"talk.session.create",
		"talk.session.join",
		"talk.session.appendAudio",
		"talk.session.startTurn",
		"talk.session.endTurn",
		"talk.session.cancelTurn",
		"talk.session.cancelOutput",
		"talk.session.submitToolResult",
		"talk.session.close",
		"talk.speak",
		"tts.enable",
		"tts.disable",
		"tts.convert",
		"tts.setProvider",
		"tts.setPersona",
		"voicewake.set",
		"voicewake.routing.set",
		"node.invoke",
		"tools.invoke",
		"chat.send",
		"chat.abort",
		"sessions.create",
		"sessions.send",
		"sessions.steer",
		"sessions.abort",
		"tasks.cancel",
		"sessions.compaction.branch",
		"doctor.memory.backfillDreamDiary",
		"doctor.memory.resetDreamDiary",
		"doctor.memory.resetGroundedShortTerm",
		"doctor.memory.repairDreamingArtifacts",
		"doctor.memory.dedupeDreamDiary",
		"push.test",
		"push.web.vapidPublicKey",
		"push.web.subscribe",
		"push.web.unsubscribe",
		"push.web.test",
		"node.pending.enqueue"
	],
	[ADMIN_SCOPE]: [
		"channels.start",
		"channels.stop",
		"channels.logout",
		"agents.create",
		"agents.update",
		"agents.delete",
		"skills.upload.begin",
		"skills.upload.chunk",
		"skills.upload.commit",
		"skills.install",
		"skills.update",
		"secrets.reload",
		"secrets.resolve",
		"cron.add",
		"cron.update",
		"cron.remove",
		"cron.run",
		"sessions.patch",
		"sessions.pluginPatch",
		"sessions.cleanup",
		"sessions.reset",
		"sessions.delete",
		"sessions.compact",
		"sessions.compaction.restore",
		"connect",
		"chat.inject",
		"nativeHook.invoke",
		"web.login.start",
		"web.login.wait",
		"set-heartbeats",
		"system-event",
		"agents.files.set",
		"update.status",
		"gateway.restart.request"
	],
	[TALK_SECRETS_SCOPE]: []
}).flatMap(([scope, methods]) => methods.map((method) => [method, scope])));
function resolveScopedMethod(method) {
	const explicitScope = METHOD_SCOPE_BY_NAME.get(method);
	if (explicitScope) return explicitScope;
	const reservedScope = resolveReservedGatewayMethodScope(method);
	if (reservedScope) return reservedScope;
	const pluginScope = getPluginRegistryState()?.activeRegistry?.gatewayMethodScopes?.[method];
	if (pluginScope) return pluginScope;
}
function isApprovalMethod(method) {
	return resolveScopedMethod(method) === APPROVALS_SCOPE;
}
function isPairingMethod(method) {
	return resolveScopedMethod(method) === PAIRING_SCOPE;
}
function isReadMethod(method) {
	return resolveScopedMethod(method) === READ_SCOPE;
}
function isWriteMethod(method) {
	return resolveScopedMethod(method) === WRITE_SCOPE;
}
function isNodeRoleMethod(method) {
	return NODE_ROLE_METHODS.has(method);
}
function isAdminOnlyMethod(method) {
	return resolveScopedMethod(method) === ADMIN_SCOPE;
}
function resolveRequiredOperatorScopeForMethod(method) {
	return resolveScopedMethod(method);
}
function normalizeSessionActionParam(value) {
	return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function resolveSessionActionRegisteredScopes(params) {
	if (!params || typeof params !== "object" || Array.isArray(params)) return;
	const pluginId = normalizeSessionActionParam(params.pluginId);
	const actionId = normalizeSessionActionParam(params.actionId);
	if (!pluginId || !actionId) return;
	const registration = getPluginRegistryState()?.activeRegistry?.sessionActions?.find((entry) => entry.pluginId === pluginId && entry.action.id === actionId);
	if (!registration) return;
	const requiredScopes = registration.action.requiredScopes;
	return requiredScopes && requiredScopes.length > 0 ? [...requiredScopes] : [WRITE_SCOPE];
}
function resolveSessionActionLeastPrivilegeScopes(params) {
	const registeredScopes = resolveSessionActionRegisteredScopes(params);
	if (registeredScopes) return registeredScopes;
	if (params && typeof params === "object" && !Array.isArray(params)) {
		const pluginId = normalizeSessionActionParam(params.pluginId);
		const actionId = normalizeSessionActionParam(params.actionId);
		if (pluginId && actionId) return [...CLI_DEFAULT_OPERATOR_SCOPES];
	}
	return [WRITE_SCOPE];
}
function resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params) {
	if (method === "plugins.sessionAction") return resolveSessionActionLeastPrivilegeScopes(params);
	return [WRITE_SCOPE];
}
function resolveLeastPrivilegeOperatorScopesForMethod(method, params) {
	if (DYNAMIC_OPERATOR_SCOPE_METHODS.has(method)) return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
	const requiredScope = resolveRequiredOperatorScopeForMethod(method);
	if (requiredScope) return [requiredScope];
	return [];
}
function authorizeOperatorScopesForMethod(method, scopes, params) {
	if (scopes.includes("operator.admin")) return { allowed: true };
	if (DYNAMIC_OPERATOR_SCOPE_METHODS.has(method)) {
		const registeredScopes = resolveSessionActionRegisteredScopes(params);
		if (!registeredScopes && params && typeof params === "object" && !Array.isArray(params)) {
			const pluginId = normalizeSessionActionParam(params.pluginId);
			const actionId = normalizeSessionActionParam(params.actionId);
			if (!pluginId || !actionId) return scopes.some((scope) => isOperatorScope(scope)) ? { allowed: true } : {
				allowed: false,
				missingScope: WRITE_SCOPE
			};
		}
		const missingScope = (registeredScopes ?? ["operator.write"]).find((scope) => {
			return !scopes.includes(scope) && !(scope === "operator.read" && scopes.includes("operator.write"));
		});
		return missingScope ? {
			allowed: false,
			missingScope
		} : { allowed: true };
	}
	const requiredScope = resolveRequiredOperatorScopeForMethod(method) ?? "operator.admin";
	if (requiredScope === "operator.read") {
		if (scopes.includes("operator.read") || scopes.includes("operator.write")) return { allowed: true };
		return {
			allowed: false,
			missingScope: READ_SCOPE
		};
	}
	if (scopes.includes(requiredScope)) return { allowed: true };
	return {
		allowed: false,
		missingScope: requiredScope
	};
}
function isGatewayMethodClassified(method) {
	if (isNodeRoleMethod(method)) return true;
	if (DYNAMIC_OPERATOR_SCOPE_METHODS.has(method)) return true;
	return resolveRequiredOperatorScopeForMethod(method) !== void 0;
}
//#endregion
export { isGatewayMethodClassified as a, isReadMethod as c, resolveRequiredOperatorScopeForMethod as d, isApprovalMethod as i, isWriteMethod as l, authorizeOperatorScopesForMethod as n, isNodeRoleMethod as o, isAdminOnlyMethod as r, isPairingMethod as s, CLI_DEFAULT_OPERATOR_SCOPES as t, resolveLeastPrivilegeOperatorScopesForMethod as u };
