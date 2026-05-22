//#region extensions/telegram/src/allow-from.ts
function normalizeTelegramAllowFromEntry(raw) {
	return (typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "").trim().replace(/^(telegram|tg):/i, "").trim();
}
function isNumericTelegramUserId(raw) {
	return /^-?\d+$/.test(raw);
}
function isNumericTelegramSenderUserId(raw) {
	return /^\d+$/.test(raw);
}
//#endregion
export { isNumericTelegramUserId as n, normalizeTelegramAllowFromEntry as r, isNumericTelegramSenderUserId as t };
