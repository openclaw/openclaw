import { n as normalizeAccountId } from "./account-id-B32J-iNN.js";
import "./pairing-store-jPMfFWFn.js";
import { t as issuePairingChallenge } from "./pairing-challenge-CSODV-T3.js";
//#region src/channels/plugins/pairing-adapters.ts
function createPairingPrefixStripper(prefixRe, map = (entry) => entry) {
	return (entry) => map(entry.trim().replace(prefixRe, "").trim());
}
function createLoggedPairingApprovalNotifier(format, log = console.log) {
	return async (params) => {
		log(typeof format === "function" ? format(params) : format);
	};
}
function createTextPairingAdapter(params) {
	return {
		idLabel: params.idLabel,
		normalizeAllowEntry: params.normalizeAllowEntry,
		notifyApproval: async (ctx) => {
			await params.notify({
				...ctx,
				message: params.message
			});
		}
	};
}
//#endregion
//#region src/plugin-sdk/pairing-access.ts
/** Scope pairing store operations to one channel/account pair for plugin-facing helpers. */
function createScopedPairingAccess(params) {
	const resolvedAccountId = normalizeAccountId(params.accountId);
	return {
		accountId: resolvedAccountId,
		readAllowFromStore: () => params.core.channel.pairing.readAllowFromStore({
			channel: params.channel,
			accountId: resolvedAccountId
		}),
		readStoreForDmPolicy: (provider, accountId) => params.core.channel.pairing.readAllowFromStore({
			channel: provider,
			accountId: normalizeAccountId(accountId)
		}),
		upsertPairingRequest: (input) => params.core.channel.pairing.upsertPairingRequest({
			channel: params.channel,
			accountId: resolvedAccountId,
			...input
		})
	};
}
//#endregion
//#region src/plugin-sdk/channel-pairing.ts
/** Pre-bind the channel id and storage sink for pairing challenges. */
function createChannelPairingChallengeIssuer(params) {
	return (challenge) => issuePairingChallenge({
		channel: params.channel,
		upsertPairingRequest: params.upsertPairingRequest,
		...challenge
	});
}
/** Build the full scoped pairing controller used by channel runtime code. */
function createChannelPairingController(params) {
	const access = createScopedPairingAccess(params);
	return {
		...access,
		issueChallenge: createChannelPairingChallengeIssuer({
			channel: params.channel,
			upsertPairingRequest: access.upsertPairingRequest
		})
	};
}
//#endregion
export { createTextPairingAdapter as a, createPairingPrefixStripper as i, createChannelPairingController as n, createLoggedPairingApprovalNotifier as r, createChannelPairingChallengeIssuer as t };
