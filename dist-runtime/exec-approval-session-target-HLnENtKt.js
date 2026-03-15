import { im as loadSessionStore, wa as resolveSessionDeliveryTarget } from "./auth-profiles-DqxBs6Au.js";
import { S as parseAgentSessionKey } from "./session-key-D2lHwVVl.js";
import { l as resolveStorePath } from "./paths-YN5WLIkL.js";
//#region src/infra/exec-approval-session-target.ts
function normalizeOptionalString(value) {
	const normalized = value?.trim();
	return normalized ? normalized : void 0;
}
function normalizeOptionalThreadId(value) {
	if (typeof value === "number") {return Number.isFinite(value) ? value : void 0;}
	if (typeof value !== "string") {return;}
	const normalized = Number.parseInt(value, 10);
	return Number.isFinite(normalized) ? normalized : void 0;
}
function resolveExecApprovalSessionTarget(params) {
	const sessionKey = normalizeOptionalString(params.request.request.sessionKey);
	if (!sessionKey) {return null;}
	const agentId = parseAgentSessionKey(sessionKey)?.agentId ?? params.request.request.agentId ?? "main";
	const entry = loadSessionStore(resolveStorePath(params.cfg.session?.store, { agentId }))[sessionKey];
	if (!entry) {return null;}
	const target = resolveSessionDeliveryTarget({
		entry,
		requestedChannel: "last",
		turnSourceChannel: normalizeOptionalString(params.turnSourceChannel),
		turnSourceTo: normalizeOptionalString(params.turnSourceTo),
		turnSourceAccountId: normalizeOptionalString(params.turnSourceAccountId),
		turnSourceThreadId: normalizeOptionalThreadId(params.turnSourceThreadId)
	});
	if (!target.to) {return null;}
	return {
		channel: normalizeOptionalString(target.channel),
		to: target.to,
		accountId: normalizeOptionalString(target.accountId),
		threadId: normalizeOptionalThreadId(target.threadId)
	};
}
//#endregion
export { resolveExecApprovalSessionTarget as t };
