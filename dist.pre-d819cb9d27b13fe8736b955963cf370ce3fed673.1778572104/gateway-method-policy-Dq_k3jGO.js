//#region src/shared/gateway-method-policy.ts
const RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES = [
	"exec.approvals.",
	"config.",
	"wizard.",
	"update."
];
const RESERVED_ADMIN_GATEWAY_METHOD_SCOPE = "operator.admin";
function isReservedAdminGatewayMethod(method) {
	return RESERVED_ADMIN_GATEWAY_METHOD_PREFIXES.some((prefix) => method.startsWith(prefix));
}
function resolveReservedGatewayMethodScope(method) {
	if (!isReservedAdminGatewayMethod(method)) return;
	return RESERVED_ADMIN_GATEWAY_METHOD_SCOPE;
}
function normalizePluginGatewayMethodScope(method, scope) {
	const reservedScope = resolveReservedGatewayMethodScope(method);
	if (!reservedScope || !scope || scope === reservedScope) return {
		scope,
		coercedToReservedAdmin: false
	};
	return {
		scope: reservedScope,
		coercedToReservedAdmin: true
	};
}
//#endregion
export { resolveReservedGatewayMethodScope as n, normalizePluginGatewayMethodScope as t };
