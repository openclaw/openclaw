//#region extensions/telegram/src/approval-callback-data.ts
const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_APPROVE_ALLOW_ALWAYS_PATTERN = /^\/approve(?:@[^\s]+)?\s+[A-Za-z0-9][A-Za-z0-9._:-]*\s+allow-always$/i;
function fitsTelegramCallbackData(value) {
	return Buffer.byteLength(value, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
}
function rewriteTelegramApprovalDecisionAlias(value) {
	if (!value.endsWith(" allow-always")) return value;
	if (!TELEGRAM_APPROVE_ALLOW_ALWAYS_PATTERN.test(value)) return value;
	return value.slice(0, -12) + "always";
}
function sanitizeTelegramCallbackData(value) {
	const rewritten = rewriteTelegramApprovalDecisionAlias(value);
	return fitsTelegramCallbackData(rewritten) ? rewritten : void 0;
}
//#endregion
export { sanitizeTelegramCallbackData as n, fitsTelegramCallbackData as t };
