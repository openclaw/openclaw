import { s as normalizeStringEntries } from "./string-normalization-DiPHgdft.js";
import { o as resolveGroupAllowFromSources } from "./allow-from-D1f7S_rf.js";
import { n as resolveControlCommandGate } from "./command-gating-BZR3snoF.js";
import { i as resolveChannelIngressEffectiveAllowFromLists, r as readChannelIngressStoreAllowFromForDmPolicy } from "./runtime-BUVuto5K.js";
import { t as resolveDmAllowAuditState } from "./dm-allow-state-B3Zdaqp6.js";
import { n as evaluateMatchedGroupAccessForPolicy } from "./group-access-jJJRcTGB.js";
//#region src/security/dm-policy-shared.ts
function resolvePinnedMainDmOwnerFromAllowlist(params) {
	if ((params.dmScope ?? "main") !== "main") return null;
	const rawAllowFrom = Array.isArray(params.allowFrom) ? params.allowFrom : [];
	if (rawAllowFrom.some((entry) => String(entry).trim() === "*")) return null;
	const normalizedOwners = Array.from(new Set(rawAllowFrom.map((entry) => params.normalizeEntry(String(entry))).filter((entry) => Boolean(entry))));
	return normalizedOwners.length === 1 ? normalizedOwners[0] : null;
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function resolveEffectiveAllowFromLists(params) {
	return resolveChannelIngressEffectiveAllowFromLists(params);
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
const dmGroupAccess = (decision, reasonCode, reason) => ({
	decision,
	reasonCode,
	reason
});
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function resolveOpenDmAllowlistAccess(params) {
	const effectiveAllowFrom = normalizeStringEntries(params.effectiveAllowFrom);
	return effectiveAllowFrom.includes("*") ? dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN, "dmPolicy=open") : params.isSenderAllowed(effectiveAllowFrom) ? dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED, "dmPolicy=open (allowlisted)") : dmGroupAccess("block", DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED, "dmPolicy=open (not allowlisted)");
}
const GROUP_ACCESS_RESULT = {
	disabled: dmGroupAccess("block", DM_GROUP_ACCESS_REASON.GROUP_POLICY_DISABLED, "groupPolicy=disabled"),
	empty_allowlist: dmGroupAccess("block", DM_GROUP_ACCESS_REASON.GROUP_POLICY_EMPTY_ALLOWLIST, "groupPolicy=allowlist (empty allowlist)"),
	missing_match_input: dmGroupAccess("block", DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED, "groupPolicy=allowlist (not allowlisted)"),
	not_allowlisted: dmGroupAccess("block", DM_GROUP_ACCESS_REASON.GROUP_POLICY_NOT_ALLOWLISTED, "groupPolicy=allowlist (not allowlisted)")
};
/** @deprecated Use `resolveChannelMessageIngress` or `readChannelIngressStoreAllowFromForDmPolicy` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
async function readStoreAllowFromForDmPolicy(params) {
	return await readChannelIngressStoreAllowFromForDmPolicy(params);
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
		if (groupAccess.allowed) return dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED, `groupPolicy=${groupPolicy}`);
		switch (groupAccess.reason) {
			case "disabled":
			case "empty_allowlist":
			case "missing_match_input":
			case "not_allowlisted": return GROUP_ACCESS_RESULT[groupAccess.reason];
			case "allowed": return dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.GROUP_POLICY_ALLOWED, `groupPolicy=${groupPolicy}`);
		}
	}
	if (dmPolicy === "disabled") return dmGroupAccess("block", DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED, "dmPolicy=disabled");
	if (dmPolicy === "open") return resolveOpenDmAllowlistAccess({
		effectiveAllowFrom,
		isSenderAllowed: params.isSenderAllowed
	});
	return params.isSenderAllowed(effectiveAllowFrom) ? dmGroupAccess("allow", DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED, `dmPolicy=${dmPolicy} (allowlisted)`) : dmPolicy === "pairing" ? dmGroupAccess("pairing", DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED, "dmPolicy=pairing (not allowlisted)") : dmGroupAccess("block", DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED, `dmPolicy=${dmPolicy} (not allowlisted)`);
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
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
	const commandGate = params.command ? resolveControlCommandGate({
		useAccessGroups: params.command.useAccessGroups,
		authorizers: [{
			configured: commandDmAllowFrom.length > 0,
			allowed: params.isSenderAllowed(commandDmAllowFrom)
		}, {
			configured: commandGroupAllowFrom.length > 0,
			allowed: params.isSenderAllowed(commandGroupAllowFrom)
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
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
async function resolveDmAllowState(params) {
	return await resolveDmAllowAuditState(params);
}
//#endregion
export { resolveDmGroupAccessWithCommandGate as a, resolveOpenDmAllowlistAccess as c, resolveDmGroupAccessDecision as i, resolvePinnedMainDmOwnerFromAllowlist as l, readStoreAllowFromForDmPolicy as n, resolveDmGroupAccessWithLists as o, resolveDmAllowState as r, resolveEffectiveAllowFromLists as s, DM_GROUP_ACCESS_REASON as t };
