import { r as getPluginRegistryState } from "./runtime-state-DRIYGASz.js";
import { n as resolveReservedGatewayMethodScope } from "./gateway-method-policy-CwyGMC_n.js";
import { a as isDynamicOperatorGatewayMethod, c as resolveCoreOperatorGatewayMethodScope, i as isCoreNodeGatewayMethod, r as isCoreGatewayMethodClassified } from "./core-descriptors-zcE5f_RQ.js";
import { a as TALK_SECRETS_SCOPE, i as READ_SCOPE, n as APPROVALS_SCOPE, o as WRITE_SCOPE, r as PAIRING_SCOPE, s as isOperatorScope, t as ADMIN_SCOPE } from "./operator-scopes-DGvgHuOd.js";
//#region src/gateway/method-scopes.ts
const CLI_DEFAULT_OPERATOR_SCOPES = [
	ADMIN_SCOPE,
	READ_SCOPE,
	WRITE_SCOPE,
	APPROVALS_SCOPE,
	PAIRING_SCOPE,
	TALK_SECRETS_SCOPE
];
function resolveScopedMethod(method) {
	const explicitScope = resolveCoreOperatorGatewayMethodScope(method);
	if (explicitScope) return explicitScope;
	const reservedScope = resolveReservedGatewayMethodScope(method);
	if (reservedScope) return reservedScope;
	const pluginScope = (getPluginRegistryState()?.activeRegistry?.gatewayMethodDescriptors?.find((descriptor) => descriptor.name === method))?.scope;
	return pluginScope === "node" || pluginScope === "dynamic" ? void 0 : pluginScope;
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
	return isCoreNodeGatewayMethod(method);
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
	if (isDynamicOperatorGatewayMethod(method)) return resolveDynamicLeastPrivilegeOperatorScopesForMethod(method, params);
	const requiredScope = resolveRequiredOperatorScopeForMethod(method);
	if (requiredScope) return [requiredScope];
	return [];
}
function authorizeOperatorScopesForMethod(method, scopes, params) {
	if (scopes.includes("operator.admin")) return { allowed: true };
	if (isDynamicOperatorGatewayMethod(method)) {
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
	if (isDynamicOperatorGatewayMethod(method)) return true;
	return isCoreGatewayMethodClassified(method) || resolveRequiredOperatorScopeForMethod(method) !== void 0;
}
//#endregion
export { isGatewayMethodClassified as a, isReadMethod as c, resolveRequiredOperatorScopeForMethod as d, isApprovalMethod as i, isWriteMethod as l, authorizeOperatorScopesForMethod as n, isNodeRoleMethod as o, isAdminOnlyMethod as r, isPairingMethod as s, CLI_DEFAULT_OPERATOR_SCOPES as t, resolveLeastPrivilegeOperatorScopesForMethod as u };
