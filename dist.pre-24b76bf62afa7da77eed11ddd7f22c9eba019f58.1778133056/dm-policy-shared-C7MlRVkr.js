import { s as normalizeStringEntries } from "./string-normalization-BeeXgDIU.js";
import { n as resolveControlCommandGate } from "./command-gating-w1GKxLl9.js";
import { a as readChannelAllowFromStore } from "./pairing-store-BlGIjT_b.js";
import { i as resolveGroupAllowFromSources, r as mergeDmAllowFromSources } from "./allow-from-CNaEs7ZT.js";
import { n as evaluateMatchedGroupAccessForPolicy } from "./group-access-C0bxOoE2.js";
//#region src/security/dm-policy-shared.ts
function resolvePinnedMainDmOwnerFromAllowlist(params) {
	if ((params.dmScope ?? "main") !== "main") return null;
	const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
	if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) return null;
	const normalizedOwners = Array.from(new Set(rawAllowFrom.map((entry) => params.normalizeEntry(String(entry))).filter((entry) => Boolean(entry))));
	return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}
function resolveEffectiveAllowFromLists(params) {
	const allowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : void 0;
	const groupAllowFrom = Array.isArray(params.groupAllowFrom) ? params.groupAllowFrom : void 0;
	return {
		effectiveAllowFrom: normalizeStringEntries(mergeDmAllowFromSources({
			allowFrom,
			storeAllowFrom: Array.isArray(params.storeAllowFrom) ? params.storeAllowFrom : void 0,
			dmPolicy: params.dmPolicy ?? void 0
		})),
		effectiveGroupAllowFrom: normalizeStringEntries(resolveGroupAllowFromSources({
			allowFrom,
			groupAllowFrom,
			fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
		}))
	};
}
const DM_GROUP_ACCESS_REASON = {
	GROUP_POLICY_ALLOWED: "group_policy_allowed",
	GROUP_POLICY_DISABLED: "group_policy_disabled",
	GROUP_POLICY_EMPTY_ALLOWLIST: "group_policy_empty_allowlist",
	GROUP_POLICY_NOT_ALLOWLISTED: "group_policy_not_allowlisted",
	DM_POLICY_OPEN: "dm_policy_open",
	DM_POLICY_DISABLED: "dm_policy_disabled",
	DM_POLICY_ALLOWLISTED: "dm_policy_allowlisted",
	DM_POLICY_PAIRING_REQUIRED: "dm_policy_pairing_required",
	DM_POLICY_NOT_ALLOWLISTED: "dm_policy_not_allowlisted"
};
function resolveOpenDmAllowlistAccess(params) {
	const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
	if (effectiveAllowFrom.includes("*")) return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN,
		reason: "dmPolicy=open"
	};
	if (params.isSenderAllowed(effectiveAllowFrom)) return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
		reason: "dmPolicy=open (allowlisted)"
	};
	return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
		reason: "dmPolicy=open (not allowlisted)"
	};
}
async function readStoreAllowFromForDmPolicy(params) {
	if (params.shouldRead === false || params.dmPolicy === "allowlist" || params.dmPolicy === "open") return [];
	return await (params.readStore ?? ((provider, accountId) => readChannelAllowFromStore(provider, process.env, accountId)))(params.provider, params.accountId).catch(() => []);
}
function resolveDmGroupAccessDecision(params) {
	const dmPolicy = params.dmPolicy ?? "pairing";
	const groupPolicy = params.groupPolicy === "open" || params.groupPolicy === "disabled" ? params.groupPolicy : "allowlist";
	const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
	const effectiveGroupAllowFrom = normalizeStringEntries(params.effectiveGroupAllowFrom);
	if (params.isGroup) {
		const groupAccess = evaluateMatchedGroupAccessForPolicy({
			groupPolicy,
			allowlistConfigured: effectiveGroupAllowFrom.length > 0,
			allowlistMatched: params.isSenderAllowed(effectiveGroupAllowFrom)
		});
		if (!groupAccess.allowed) {
			if (groupAccess.reason === "disabled") return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED,
				reason: "groupPolicy=disabled"
			};
			if (groupAccess.reason === "empty_allowlist") return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST,
				reason: "groupPolicy=allowlist (empty allowlist)"
			};
			if (groupAccess.reason === "not_allowlisted") return {
				decision: "block",
				reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED,
				reason: "groupPolicy=allowlist (not allowlisted)"
			};
		}
		return {
			decision: "allow",
			reasonCode: DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED,
			reason: `groupPolicy=${groupPolicy}`
		};
	}
	if (dmPolicy === "disabled") return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED,
		reason: "dmPolicy=disabled"
	};
	if (dmPolicy === "open") return resolveOpenDmAllowlistAccess({
		effectiveAllowFrom,
		isSenderAllowed: params.isSenderAllowed
	});
	if (params.isSenderAllowed(effectiveAllowFrom)) return {
		decision: "allow",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED,
		reason: `dmPolicy=${dmPolicy} (allowlisted)`
	};
	if (dmPolicy === "pairing") return {
		decision: "pairing",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED,
		reason: "dmPolicy=pairing (not allowlisted)"
	};
	return {
		decision: "block",
		reasonCode: DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED,
		reason: `dmPolicy=${dmPolicy} (not allowlisted)`
	};
}
function resolveDmGroupAccessWithLists(params) {
	const { effectiveAllowFrom, effectiveGroupAllowFrom } = resolveEffectiveAllowFromLists({
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		dmPolicy: params.dmPolicy,
		groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom
	});
	return {
		...resolveDmGroupAccessDecision({
			isGroup: params.isGroup,
			dmPolicy: params.dmPolicy,
			groupPolicy: params.groupPolicy,
			effectiveAllowFrom,
			effectiveGroupAllowFrom,
			isSenderAllowed: params.isSenderAllowed
		}),
		effectiveAllowFrom,
		effectiveGroupAllowFrom
	};
}
function resolveDmGroupAccessWithCommandGate(params) {
	const access = resolveDmGroupAccessWithLists({
		isGroup: params.isGroup,
		dmPolicy: params.dmPolicy,
		groupPolicy: params.groupPolicy,
		allowFrom: params.allowFrom,
		groupAllowFrom: params.groupAllowFrom,
		storeAllowFrom: params.storeAllowFrom,
		groupAllowFromFallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom,
		isSenderAllowed: params.isSenderAllowed
	});
	const configuredAllowFrom = normalizeStringEntries(params.allowFrom ?? []);
	const configuredGroupAllowFrom = normalizeStringEntries(resolveGroupAllowFromSources({
		allowFrom: configuredAllowFrom,
		groupAllowFrom: normalizeStringEntries(params.groupAllowFrom ?? []),
		fallbackToAllowFrom: params.groupAllowFromFallbackToAllowFrom ?? void 0
	}));
	const commandDmAllowFrom = params.isGroup ? configuredAllowFrom : access.effectiveAllowFrom;
	const commandGroupAllowFrom = params.isGroup ? configuredGroupAllowFrom : access.effectiveGroupAllowFrom;
	const ownerAllowedForCommands = params.isSenderAllowed(commandDmAllowFrom);
	const groupAllowedForCommands = params.isSenderAllowed(commandGroupAllowFrom);
	const commandGate = params.command ? resolveControlCommandGate({
		useAccessGroups: params.command.useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: ownerAllowedForCommands
		}, {
			configured: commandGroupAllowFrom.length > 0,
			allowed: groupAllowedForCommands
		}],
		allowTextCommands: params.command.allowTextCommands,
		hasControlCommand: params.command.hasControlCommand
	}) : {
		commandAuthorized: false,
		shouldBlock: false
	};
	return {
		...access,
		commandAuthorized: commandGate.commandAuthorized,
		shouldBlockControlCommand: params.isGroup && commandGate.shouldBlock
	};
}
async function resolveDmAllowState(params) {
	const configAllowFrom = normalizeStringEntries(Array.isArray(params.allowFrom) ? params.allowFrom : void 0);
	const hasWildcard = configAllowFrom.includes("*");
	const storeAllowFrom = await readStoreAllowFromForDmPolicy({
		provider: params.provider,
		accountId: params.accountId,
		dmPolicy: params.dmPolicy,
		readStore: params.readStore
	});
	const normalizeEntry = params.normalizeEntry ?? ((value) => value);
	const normalizedCfg = configAllowFrom.filter((value) => value !== "*").map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const normalizedStore = storeAllowFrom.map((value) => normalizeEntry(value)).map((value) => value.trim()).filter(Boolean);
	const allowCount = new Set([...normalizedCfg, ...normalizedStore]).size;
	return {
		configAllowFrom,
		hasWildcard,
		allowCount,
		isMultiUserDm: hasWildcard || allowCount > 1
	};
}
//#endregion
export { resolveDmGroupAccessWithCommandGate as a, resolveOpenDmAllowlistAccess as c, resolveDmGroupAccessDecision as i, resolvePinnedMainDmOwnerFromAllowlist as l, readStoreAllowFromForDmPolicy as n, resolveDmGroupAccessWithLists as o, resolveDmAllowState as r, resolveEffectiveAllowFromLists as s, DM_GROUP_ACCESS_REASON as t };
