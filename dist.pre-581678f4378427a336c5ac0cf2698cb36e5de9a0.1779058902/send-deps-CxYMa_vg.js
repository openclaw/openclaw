//#region src/infra/outbound/send-deps.ts
function resolveLegacyOutboundSendDepKeys(channelId) {
	const compact = channelId.replace(/[^a-z0-9]+/gi, "");
	if (!compact) return [];
	const pascal = compact.charAt(0).toUpperCase() + compact.slice(1);
	const keys = /* @__PURE__ */ new Set();
	keys.add(`send${pascal}`);
	if (pascal.startsWith("I") && pascal.length > 1) keys.add(`sendI${pascal.slice(1)}`);
	if (pascal.startsWith("Ms") && pascal.length > 2) keys.add(`sendMS${pascal.slice(2)}`);
	return [...keys];
}
function resolveOutboundSendDep(deps, channelId, options) {
	const dynamic = deps?.[channelId];
	if (dynamic !== void 0) return dynamic;
	const legacyKeys = [...resolveLegacyOutboundSendDepKeys(channelId), ...options?.legacyKeys ?? []];
	for (const legacyKey of legacyKeys) {
		const legacy = deps?.[legacyKey];
		if (legacy !== void 0) return legacy;
	}
}
//#endregion
export { resolveOutboundSendDep as n, resolveLegacyOutboundSendDepKeys as t };
