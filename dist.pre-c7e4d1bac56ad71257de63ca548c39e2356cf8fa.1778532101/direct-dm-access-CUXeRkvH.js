import { n as readStoreAllowFromForDmPolicy, o as resolveDmGroupAccessWithLists } from "./dm-policy-shared-CFD2FPpz.js";
import { n as expandAllowFromWithAccessGroups } from "./access-groups-7z8n_dSr.js";
//#region src/plugin-sdk/direct-dm-access.ts
/** Resolve direct-DM policy, effective allowlists, and optional command auth in one place. */
async function resolveInboundDirectDmAccessWithRuntime(params) {
	const dmPolicy = params.dmPolicy ?? "pairing";
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
	const shouldComputeAuth = params.runtime.shouldComputeCommandAuthorized(params.rawBody, params.cfg);
	const senderAllowedForCommands = params.isSenderAllowed(params.senderId, access.effectiveAllowFrom);
	const commandAuthorized = shouldComputeAuth ? params.runtime.resolveCommandAuthorizedFromAuthorizers({
		useAccessGroups: params.cfg.commands?.useAccessGroups !== false,
		authorizers: [{
			configured: access.effectiveAllowFrom.length > 0,
			allowed: senderAllowedForCommands
		}],
		modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff
	}) : void 0;
	return {
		access: {
			decision: access.decision,
			reasonCode: access.reasonCode,
			reason: access.reason,
			effectiveAllowFrom: access.effectiveAllowFrom
		},
		shouldComputeAuth,
		senderAllowedForCommands,
		commandAuthorized
	};
}
/** Convert resolved DM policy into a pre-crypto allow/block/pairing callback. */
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
