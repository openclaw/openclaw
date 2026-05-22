import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
//#region src/routing/account-lookup.ts
function resolveAccountEntry(accounts, accountId) {
	if (!accounts || typeof accounts !== "object") return;
	if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
	const normalized = normalizeLowercaseStringOrEmpty(accountId);
	const matchKey = Object.keys(accounts).find((key) => normalizeLowercaseStringOrEmpty(key) === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
function resolveNormalizedAccountEntry(accounts, accountId, normalizeAccountId) {
	if (!accounts || typeof accounts !== "object") return;
	if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
	const normalized = normalizeAccountId(accountId);
	const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
//#endregion
export { resolveNormalizedAccountEntry as n, resolveAccountEntry as t };
