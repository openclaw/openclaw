//#region extensions/telegram/src/audit.ts
function collectTelegramUnmentionedGroupIds(groups) {
	if (!groups || typeof groups !== "object") return {
		groupIds: [],
		unresolvedGroups: 0,
		hasWildcardUnmentionedGroups: false
	};
	const hasWildcardUnmentionedGroups = Boolean(groups["*"]?.requireMention === false) && groups["*"]?.enabled !== false;
	const groupIds = [];
	let unresolvedGroups = 0;
	for (const [key, value] of Object.entries(groups)) {
		if (key === "*") continue;
		if (!value || typeof value !== "object") continue;
		if (value.enabled === false) continue;
		if (value.requireMention !== false) continue;
		const id = String(key).trim();
		if (!id) continue;
		if (/^-?\d+$/.test(id)) groupIds.push(id);
		else unresolvedGroups += 1;
	}
	groupIds.sort((a, b) => a.localeCompare(b));
	return {
		groupIds,
		unresolvedGroups,
		hasWildcardUnmentionedGroups
	};
}
let auditMembershipRuntimePromise = null;
function loadAuditMembershipRuntime() {
	auditMembershipRuntimePromise ??= import("./audit-membership-runtime-Dn3tRdQ8.js");
	return auditMembershipRuntimePromise;
}
async function auditTelegramGroupMembership(params) {
	const started = Date.now();
	const token = params.token?.trim() ?? "";
	if (!token || params.groupIds.length === 0) return {
		ok: true,
		checkedGroups: 0,
		unresolvedGroups: 0,
		hasWildcardUnmentionedGroups: false,
		groups: [],
		elapsedMs: Date.now() - started
	};
	const { auditTelegramGroupMembershipImpl } = await loadAuditMembershipRuntime();
	return {
		...await auditTelegramGroupMembershipImpl({
			...params,
			token
		}),
		elapsedMs: Date.now() - started
	};
}
//#endregion
export { collectTelegramUnmentionedGroupIds as n, auditTelegramGroupMembership as t };
