import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "../../string-coerce-DyL154ka.js";
import "../../string-coerce-runtime-BAEEbdFW.js";
import { n as approveDevicePairing } from "../../device-pairing-C3feAqgm.js";
import "../../api-PgcRd7LM.js";
import { r as formatPendingRequests } from "../../notify-C922nV88.js";
//#region extensions/device-pair/pair-command-approve.ts
function buildMultiplePendingApprovalReply(pending) {
	return { text: `${formatPendingRequests(pending)}\n\nMultiple pending requests found. Approve one explicitly:
/pair approve <requestId>
Or approve the most recent:
/pair approve latest` };
}
function selectPendingApprovalRequest(params) {
	if (params.pending.length === 0) return { reply: { text: "No pending device pairing requests." } };
	if (!params.requested) return params.pending.length === 1 ? { pending: params.pending[0] } : { reply: buildMultiplePendingApprovalReply(params.pending) };
	if (normalizeLowercaseStringOrEmpty(params.requested) === "latest") {
		let latest = params.pending[0];
		for (let index = 1; index < params.pending.length; index += 1) {
			const pending = params.pending[index];
			if ((pending.ts ?? 0) > (latest.ts ?? 0)) latest = pending;
		}
		return { pending: latest };
	}
	return {
		pending: params.pending.find((entry) => entry.requestId === params.requested),
		reply: void 0
	};
}
function formatApprovedPairingReply(approved) {
	const label = normalizeOptionalString(approved.device.displayName) || approved.device.deviceId;
	const platform = normalizeOptionalString(approved.device.platform);
	return { text: `✅ Paired ${label}${platform ? ` (${platform})` : ""}.` };
}
function formatForbiddenPairingRequirement(approved) {
	return approved.scope ?? approved.role ?? "additional approval";
}
async function approvePendingPairingRequest(params) {
	const approved = params.callerScopes === void 0 ? await approveDevicePairing(params.requestId) : await approveDevicePairing(params.requestId, { callerScopes: params.callerScopes });
	if (!approved) return { text: "Pairing request not found." };
	if (approved.status === "forbidden") return { text: `⚠️ This command requires ${formatForbiddenPairingRequirement(approved)} to approve this pairing request.` };
	return formatApprovedPairingReply(approved);
}
//#endregion
export { approvePendingPairingRequest, selectPendingApprovalRequest };
