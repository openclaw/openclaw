//#region extensions/telegram/src/request-timeouts.ts
const TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS = 45e3;
const TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS = 6e4;
const TELEGRAM_REQUEST_TIMEOUTS_MS = {
	deletemycommands: 15e3,
	deletewebhook: 15e3,
	deletemessage: 15e3,
	editforumtopic: 15e3,
	editmessagetext: 15e3,
	getchat: 15e3,
	getfile: 3e4,
	getme: 15e3,
	getupdates: TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS,
	pinchatmessage: 15e3,
	sendanimation: 3e4,
	sendaudio: 3e4,
	sendchataction: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
	senddocument: 3e4,
	sendmessage: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
	sendmessagedraft: TELEGRAM_OUTBOUND_TEXT_REQUEST_TIMEOUT_MS,
	sendphoto: 3e4,
	sendvideo: 3e4,
	sendvoice: 3e4,
	setmessagereaction: 1e4,
	setmycommands: 15e3,
	setwebhook: 15e3
};
function resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) {
	if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) return;
	return Math.max(1, Math.floor(timeoutSeconds)) * 1e3;
}
function resolveTelegramRequestTimeoutMs(method, timeoutSeconds) {
	if (!method) return;
	const baseTimeoutMs = TELEGRAM_REQUEST_TIMEOUTS_MS[method];
	if (baseTimeoutMs === void 0 || method === "getupdates") return baseTimeoutMs;
	return Math.max(baseTimeoutMs, resolveConfiguredTelegramRequestTimeoutMs(timeoutSeconds) ?? 0);
}
function resolveTelegramStartupProbeTimeoutMs(timeoutSeconds) {
	const getMeTimeoutMs = resolveTelegramRequestTimeoutMs("getme") ?? 15e3;
	if (typeof timeoutSeconds !== "number" || !Number.isFinite(timeoutSeconds)) return getMeTimeoutMs;
	const configuredTimeoutMs = Math.max(1, Math.floor(timeoutSeconds)) * 1e3;
	return Math.max(getMeTimeoutMs, configuredTimeoutMs);
}
//#endregion
export { resolveTelegramRequestTimeoutMs as n, resolveTelegramStartupProbeTimeoutMs as r, TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS as t };
