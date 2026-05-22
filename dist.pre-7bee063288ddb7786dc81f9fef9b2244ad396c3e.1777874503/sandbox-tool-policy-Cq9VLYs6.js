//#region src/agents/sandbox-tool-policy.ts
function unionAllow(base, extra) {
	if (!Array.isArray(extra) || extra.length === 0) return base;
	if (!Array.isArray(base)) return Array.from(new Set(["*", ...extra]));
	if (base.length === 0) return Array.from(new Set(["*", ...extra]));
	return Array.from(new Set([...base, ...extra]));
}
function pickSandboxToolPolicy(config) {
	if (!config) return;
	const allow = Array.isArray(config.allow) ? unionAllow(config.allow, config.alsoAllow) : Array.isArray(config.alsoAllow) && config.alsoAllow.length > 0 ? unionAllow(void 0, config.alsoAllow) : void 0;
	const deny = Array.isArray(config.deny) ? config.deny : void 0;
	if (!allow && !deny) return;
	return {
		allow,
		deny
	};
}
//#endregion
export { pickSandboxToolPolicy as t };
