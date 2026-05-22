//#region src/plugin-sdk/access-groups.ts
const ACCESS_GROUP_ALLOW_FROM_PREFIX = "accessGroup:";
function parseAccessGroupAllowFromEntry(entry) {
	const trimmed = entry.trim();
	if (!trimmed.startsWith("accessGroup:")) return null;
	const name = trimmed.slice(12).trim();
	return name.length > 0 ? name : null;
}
function resolveMessageSenderGroupEntries(params) {
	if (params.group.type !== "message.senders") return [];
	return [...params.group.members["*"] ?? [], ...params.group.members[params.channel] ?? []];
}
async function resolveAccessGroupAllowFromMatches(params) {
	const cfg = params.cfg;
	const groups = cfg?.accessGroups;
	if (!groups) return [];
	const names = Array.from(new Set((params.allowFrom ?? []).map((entry) => parseAccessGroupAllowFromEntry(String(entry))).filter((entry) => entry != null)));
	if (names.length === 0) return [];
	const matched = [];
	for (const name of names) {
		const group = groups[name];
		if (!group) continue;
		const senderEntries = resolveMessageSenderGroupEntries({
			group,
			channel: params.channel
		});
		if (senderEntries.length > 0 && params.isSenderAllowed?.(params.senderId, senderEntries) === true) {
			matched.push(`${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`);
			continue;
		}
		let allowed = false;
		try {
			allowed = await params.resolveMembership?.({
				cfg,
				name,
				group,
				channel: params.channel,
				accountId: params.accountId,
				senderId: params.senderId
			}) === true;
		} catch {
			allowed = false;
		}
		if (allowed) matched.push(`${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`);
	}
	return matched;
}
async function expandAllowFromWithAccessGroups(params) {
	const allowFrom = (params.allowFrom ?? []).map(String);
	if ((await resolveAccessGroupAllowFromMatches({
		cfg: params.cfg,
		allowFrom,
		channel: params.channel,
		accountId: params.accountId,
		senderId: params.senderId,
		isSenderAllowed: params.isSenderAllowed,
		resolveMembership: params.resolveMembership
	})).length === 0) return allowFrom;
	const senderEntry = params.senderAllowEntry ?? params.senderId;
	return Array.from(new Set([...allowFrom, senderEntry]));
}
//#endregion
export { resolveAccessGroupAllowFromMatches as i, expandAllowFromWithAccessGroups as n, parseAccessGroupAllowFromEntry as r, ACCESS_GROUP_ALLOW_FROM_PREFIX as t };
