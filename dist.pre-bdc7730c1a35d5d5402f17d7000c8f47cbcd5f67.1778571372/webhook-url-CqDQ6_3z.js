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
export { resolveCronNotificationSessionKey as a, resolveCronDeliverySessionKey as i, assertSafeCronSessionTargetId as n, resolveCronSessionTargetSessionKey as o, isInvalidCronSessionTargetIdError as r, normalizeHttpWebhookUrl as t };
