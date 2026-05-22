//#region src/plugin-sdk/account-configured-ids.ts
/** List normalized configured account ids from a raw channel account record map. */
function listConfiguredAccountIds(params) {
	if (!params.accounts) return [];
	const ids = /* @__PURE__ */ new Set();
	for (const key of Object.keys(params.accounts)) {
		if (!key) continue;
		ids.add(params.normalizeAccountId(key));
	}
	return [...ids];
}
//#endregion
export { listConfiguredAccountIds as t };
