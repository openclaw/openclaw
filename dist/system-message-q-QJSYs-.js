//#region src/infra/system-message.ts
const SYSTEM_MARK = "⚙️";
function normalizeSystemText(value) {
	return value.trim();
}
function hasSystemMark(text) {
	return normalizeSystemText(text).startsWith(SYSTEM_MARK);
}
function prefixSystemMessage(text) {
	const normalized = normalizeSystemText(text);
	if (!normalized) return normalized;
	if (hasSystemMark(normalized)) return normalized;
	return `${SYSTEM_MARK} ${normalized}`;
}
//#endregion
export { hasSystemMark as n, prefixSystemMessage as r, SYSTEM_MARK as t };
