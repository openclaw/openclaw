import { o as normalizeDeliveryContext } from "./delivery-context.shared-CBmB9dF7.js";
import { u as extractDeliveryInfo } from "./sessions-CQHHcgC_.js";
//#region src/cron/delivery-context.ts
function cronDeliveryFromContext(context) {
	const normalized = normalizeDeliveryContext(context);
	if (!normalized?.to) return null;
	const delivery = {
		mode: "announce",
		to: normalized.to
	};
	if (normalized.channel) delivery.channel = normalized.channel;
	if (normalized.accountId) delivery.accountId = normalized.accountId;
	if (normalized.threadId != null) delivery.threadId = normalized.threadId;
	return delivery;
}
function resolveCronStoredDeliveryContext(params) {
	const sessionKey = params.sessionKey?.trim();
	if (!sessionKey) return;
	const { deliveryContext, threadId } = extractDeliveryInfo(sessionKey, { cfg: params.cfg });
	if (deliveryContext && threadId) return {
		...deliveryContext,
		threadId
	};
	return deliveryContext;
}
function resolveCronCreationDelivery(params) {
	return cronDeliveryFromContext(params.currentDeliveryContext) ?? cronDeliveryFromContext(resolveCronStoredDeliveryContext({
		cfg: params.cfg,
		sessionKey: params.agentSessionKey
	}));
}
//#endregion
//#region src/cron/session-target.ts
const INVALID_CRON_SESSION_TARGET_ID_ERROR = "invalid cron sessionTarget session id";
function isInvalidCronSessionTargetIdError(error) {
	return error instanceof Error && error.message === INVALID_CRON_SESSION_TARGET_ID_ERROR;
}
function assertSafeCronSessionTargetId(sessionId) {
	const trimmed = sessionId.trim();
	if (!trimmed) throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
	if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) throw new Error(INVALID_CRON_SESSION_TARGET_ID_ERROR);
	return trimmed;
}
function resolveCronSessionTargetSessionKey(sessionTarget) {
	if (typeof sessionTarget !== "string" || !sessionTarget.startsWith("session:")) return;
	return assertSafeCronSessionTargetId(sessionTarget.slice(8));
}
function resolveCronCurrentSessionTarget(params) {
	if (params.sessionTarget !== "current") return params.sessionTarget ?? void 0;
	const sessionKey = params.sessionKey?.trim();
	return sessionKey ? `session:${assertSafeCronSessionTargetId(sessionKey)}` : "isolated";
}
function resolveCronDeliverySessionKey(job) {
	const sessionTargetKey = resolveCronSessionTargetSessionKey(job.sessionTarget);
	if (sessionTargetKey) return sessionTargetKey;
	return typeof job.sessionKey === "string" && job.sessionKey.trim() ? job.sessionKey.trim() : void 0;
}
function resolveCronNotificationSessionKey(params) {
	return typeof params.sessionKey === "string" && params.sessionKey.trim() ? params.sessionKey.trim() : `cron:${params.jobId}:failure`;
}
//#endregion
//#region src/cron/webhook-url.ts
function isAllowedWebhookProtocol(protocol) {
	return protocol === "http:" || protocol === "https:";
}
function normalizeHttpWebhookUrl(value) {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!trimmed) return null;
	try {
		if (!isAllowedWebhookProtocol(new URL(trimmed).protocol)) return null;
		return trimmed;
	} catch {
		return null;
	}
}
//#endregion
export { resolveCronDeliverySessionKey as a, resolveCronCreationDelivery as c, resolveCronCurrentSessionTarget as i, resolveCronStoredDeliveryContext as l, assertSafeCronSessionTargetId as n, resolveCronNotificationSessionKey as o, isInvalidCronSessionTargetIdError as r, resolveCronSessionTargetSessionKey as s, normalizeHttpWebhookUrl as t };
