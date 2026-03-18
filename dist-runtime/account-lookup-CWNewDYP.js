import { n as __esmMin } from "./chunk-DORXReHP.js";
//#region src/routing/account-lookup.ts
function resolveAccountEntry(accounts, accountId) {
	if (!accounts || typeof accounts !== "object") return;
	if (Object.hasOwn(accounts, accountId)) return accounts[accountId];
	const normalized = accountId.toLowerCase();
	const matchKey = Object.keys(accounts).find((key) => key.toLowerCase() === normalized);
	return matchKey ? accounts[matchKey] : void 0;
}
var init_account_lookup = __esmMin((() => {}));
//#endregion
export { resolveAccountEntry as n, init_account_lookup as t };
