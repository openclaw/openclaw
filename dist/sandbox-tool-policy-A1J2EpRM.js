//#region src/agents/sandbox-tool-policy.ts
const IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW = Symbol.for("openclaw.toolPolicy.implicitAllowAllFromAlsoAllow");
function unionAllow(base, extra) {
	if (!Array.isArray(extra) || extra.length === 0) return base;
	if (!Array.isArray(base)) return Array.from(new Set(["*", ...extra]));
	if (base.length === 0) return Array.from(new Set(["*", ...extra]));
	return Array.from(new Set([...base, ...extra]));
}
function hasExplicitAllowAll(list) {
	return Array.isArray(list) && list.some((entry) => entry.trim() === "*");
}
function pickSandboxToolPolicy(config) {
	if (!config) return;
	const allowFromAlsoAllowOnly = !Array.isArray(config.allow) && Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0 && !hasExplicitAllowAll(config.alsoAllow);
	const allow = Array.isArray(config.allow) ? unionAllow(config.allow, config.alsoAllow) : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0 ? unionAllow(void 0, config.alsoAllow) : void 0;
	const deny = Array.isArray(config.deny) ? config.deny : void 0;
	if (!allow && !deny) return;
	const policy = {
		allow,
		deny
	};
	if (allowFromAlsoAllowOnly) Object.defineProperty(policy, IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW, { value: true });
	return policy;
}
//#endregion
export { pickSandboxToolPolicy as n, IMPLICIT_ALLOW_ALL_FROM_ALSO_ALLOW as t };
