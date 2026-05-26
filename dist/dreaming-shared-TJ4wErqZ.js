import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
//#region extensions/memory-core/src/dreaming-shared.ts
function normalizeTrimmedString(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function includesSystemEventToken(cleanedBody, eventText) {
	const normalizedBody = normalizeTrimmedString(cleanedBody);
	const normalizedEventText = normalizeTrimmedString(eventText);
	if (!normalizedBody || !normalizedEventText) return false;
	if (normalizedBody === normalizedEventText) return true;
	return normalizedBody.split(/\r?\n/).some((line) => {
		const trimmed = line.trim();
		if (trimmed === normalizedEventText) return true;
		return trimmed.replace(/^\[cron:[^\]]+\]\s*/, "") === normalizedEventText;
	});
}
//#endregion
export { normalizeTrimmedString as n, includesSystemEventToken as t };
