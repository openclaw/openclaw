import { n as normalizeDeviceAuthScopes, t as normalizeDeviceAuthRole } from "./device-auth-Cm0WAJ4e.js";
//#region src/shared/device-bootstrap-profile.ts
const BOOTSTRAP_HANDOFF_OPERATOR_SCOPES = [
	"operator.approvals",
	"operator.read",
	"operator.talk.secrets",
	"operator.write"
];
const BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET = new Set(BOOTSTRAP_HANDOFF_OPERATOR_SCOPES);
const PAIRING_SETUP_BOOTSTRAP_PROFILE = {
	roles: ["node", "operator"],
	scopes: [...BOOTSTRAP_HANDOFF_OPERATOR_SCOPES]
};
function resolveBootstrapProfileScopesForRole(role, scopes) {
	const normalizedRole = normalizeDeviceAuthRole(role);
	const normalizedScopes = normalizeDeviceAuthScopes(Array.from(scopes));
	if (normalizedRole === "operator") return normalizedScopes.filter((scope) => BOOTSTRAP_HANDOFF_OPERATOR_SCOPE_SET.has(scope));
	return [];
}
function resolveBootstrapProfileScopesForRoles(roles, scopes) {
	return normalizeDeviceAuthScopes(roles.flatMap((role) => resolveBootstrapProfileScopesForRole(role, scopes)));
}
function normalizeDeviceBootstrapHandoffProfile(input) {
	const profile = normalizeDeviceBootstrapProfile(input);
	return {
		roles: profile.roles,
		scopes: resolveBootstrapProfileScopesForRoles(profile.roles, profile.scopes)
	};
}
function normalizeBootstrapRoles(roles) {
	if (!Array.isArray(roles)) return [];
	const out = /* @__PURE__ */ new Set();
	for (const role of roles) {
		const normalized = normalizeDeviceAuthRole(role);
		if (normalized) out.add(normalized);
	}
	return [...out].toSorted();
}
function normalizeDeviceBootstrapProfile(input) {
	return {
		roles: normalizeBootstrapRoles(input?.roles),
		scopes: normalizeDeviceAuthScopes(input?.scopes ? [...input.scopes] : [])
	};
}
//#endregion
export { resolveBootstrapProfileScopesForRoles as a, resolveBootstrapProfileScopesForRole as i, normalizeDeviceBootstrapHandoffProfile as n, normalizeDeviceBootstrapProfile as r, PAIRING_SETUP_BOOTSTRAP_PROFILE as t };
