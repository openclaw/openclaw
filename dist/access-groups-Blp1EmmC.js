import { a as parseAccessGroupAllowFromEntry, t as ACCESS_GROUP_ALLOW_FROM_PREFIX } from "./allow-from-D1f7S_rf.js";
//#region src/plugin-sdk/access-groups.ts
function resolveMessageSenderGroupEntries(params) {
	if (params.group.type !== "message.senders") return [];
	return [...params.group.members["*"] ?? [], ...params.group.members[params.channel] ?? []];
}
async function resolveAccessGroupAllowFromState(params) {
	const names = Array.from(new Set((params.allowFrom ?? []).map((entry) => parseAccessGroupAllowFromEntry(String(entry))).filter((entry) => entry != null)));
	const state = {
		referenced: names,
		matched: [],
		missing: [],
		unsupported: [],
		failed: [],
		matchedAllowFromEntries: [],
		hasReferences: names.length > 0,
		hasMatch: false
	};
	const groups = params.accessGroups;
	for (const name of names) {
		const group = groups?.[name];
		if (!group) {
			state.missing.push(name);
			continue;
		}
		const senderEntries = resolveMessageSenderGroupEntries({
			group,
			channel: params.channel
		});
		if (senderEntries.length > 0 && params.isSenderAllowed?.(params.senderId, senderEntries) === true) {
			state.matched.push(name);
			continue;
		}
		if (!params.resolveMembership) {
			if (group.type !== "message.senders") state.unsupported.push(name);
			continue;
		}
		let allowed = false;
		try {
			allowed = await params.resolveMembership({
				name,
				group,
				channel: params.channel,
				accountId: params.accountId,
				senderId: params.senderId
			});
		} catch {
			state.failed.push(name);
			continue;
		}
		if (allowed) state.matched.push(name);
	}
	state.matchedAllowFromEntries = state.matched.map((name) => `${ACCESS_GROUP_ALLOW_FROM_PREFIX}${name}`);
	state.hasMatch = state.matchedAllowFromEntries.length > 0;
	return state;
}
async function resolveAccessGroupAllowFromMatches(params) {
	const cfg = params.cfg;
	const resolveMembership = params.resolveMembership;
	return (await resolveAccessGroupAllowFromState({
		accessGroups: cfg?.accessGroups,
		allowFrom: params.allowFrom,
		channel: params.channel,
		accountId: params.accountId,
		senderId: params.senderId,
		isSenderAllowed: params.isSenderAllowed,
		resolveMembership: resolveMembership && cfg ? async (lookupParams) => await resolveMembership({
			cfg,
			...lookupParams
		}) : void 0
	})).matchedAllowFromEntries;
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
export { resolveAccessGroupAllowFromMatches as n, resolveAccessGroupAllowFromState as r, expandAllowFromWithAccessGroups as t };
