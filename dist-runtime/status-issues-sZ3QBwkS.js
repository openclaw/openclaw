//#region extensions/shared/status-issues.ts
function readStatusIssueFields(value, fields) {
	if (!value || typeof value !== "object") return null;
	const record = value;
	const result = {};
	for (const field of fields) result[field] = record[field];
	return result;
}
function coerceStatusIssueAccountId(value) {
	return typeof value === "string" ? value : typeof value === "number" ? String(value) : void 0;
}
//#endregion
export { readStatusIssueFields as n, coerceStatusIssueAccountId as t };
