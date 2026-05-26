import { n as readStoreAllowFromForDmPolicy, o as resolveDmGroupAccessWithLists, t as DM_GROUP_ACCESS_REASON } from "./dm-policy-shared-CXEKnzKD.js";
import "./channel-access-compat-EGOB-mde.js";
import { t as expandAllowFromWithAccessGroups } from "./access-groups-Blp1EmmC.js";
//#region src/plugin-sdk/direct-dm-access.ts
function toLegacyDmReasonCode(reasonCode) {
	switch (reasonCode) {
		case DM_GROUP_ACCESS_REASON.DM_POLICY_OPEN:
		case DM_GROUP_ACCESS_REASON.DM_POLICY_DISABLED:
		case DM_GROUP_ACCESS_REASON.DM_POLICY_ALLOWLISTED:
		case DM_GROUP_ACCESS_REASON.DM_POLICY_PAIRING_REQUIRED:
		case DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED: return reasonCode;
		default: return DM_GROUP_ACCESS_REASON.DM_POLICY_NOT_ALLOWLISTED;
	}
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
async function resolveInboundDirectDmAccessWithRuntime(params) {
	const dmPolicy = params.dmPolicy ?? "pairing";
	const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	const storeAllowFrom = dmPolicy === "pairing" ? await readStoreAllowFromForDmPolicy({
		provider: params.channel,
		accountId: params.accountId,
		dmPolicy,
		readStore: params.readStoreAllowFrom
	}) : [];
	const [allowFrom, effectiveStoreAllowFrom] = await Promise.all([expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: params.allowFrom,
		channel: params.channel,
		accountId: params.accountId,
		senderId: params.senderId,
		isSenderAllowed: params.isSenderAllowed,
		resolveMembership: params.resolveAccessGroupMembership
	}), expandAllowFromWithAccessGroups({
		cfg: params.cfg,
		allowFrom: storeAllowFrom,
		channel: params.channel,
		accountId: params.accountId,
		senderId: params.senderId,
		isSenderAllowed: params.isSenderAllowed,
		resolveMembership: params.resolveAccessGroupMembership
	})]);
	const access = resolveDmGroupAccessWithLists({
		isGroup: false,
		dmPolicy,
		allowFrom,
		storeAllowFrom: effectiveStoreAllowFrom,
		groupAllowFromFallbackToAllowFrom: false,
		isSenderAllowed: (allowEntries) => params.isSenderAllowed(params.senderId, allowEntries)
	});
	const reasonCode = toLegacyDmReasonCode(access.reasonCode);
	const senderAllowedForCommands = params.isSenderAllowed(params.senderId, access.effectiveAllowFrom);
	const commandAuthorized = shouldComputeAuth ? params.runtime.resolveCommandAuthorizedFromAuthorizers?.({
		useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
		authorizers: [{
			configured: access.effectiveAllowFrom.length > 0,
			allowed: senderAllowedForCommands
		}],
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	}) ?? senderAllowedForCommands : void 0;
	return {
		access: {
			decision: access.decision,
			reasonCode,
			reason: access.reason,
			effectiveAllowFrom: access.effectiveAllowFrom
		},
		shouldComputeAuth,
		senderAllowedForCommands,
		commandAuthorized
	};
}
/** @deprecated Use `resolveChannelMessageIngress` from `openclaw/plugin-sdk/channel-ingress-runtime`. */
function createPreCryptoDirectDmAuthorizer(params) {
	return async (input) => {
		const resolved = await params.resolveAccess(input.senderId);
		const access = "access" in resolved ? resolved.access : resolved;
		if (access.decision === "allow") return "allow";
		if (access.decision === "pairing") {
			if (params.issuePairingChallenge) await params.issuePairingChallenge({
				senderId: input.senderId,
				reply: input.reply
			});
			return "pairing";
		}
		params.onBlocked?.({
			senderId: input.senderId,
			reason: access.reason,
			reasonCode: access.reasonCode
		});
		return "block";
	};
}
//#endregion
export { resolveInboundDirectDmAccessWithRuntime as n, createPreCryptoDirectDmAuthorizer as t };
