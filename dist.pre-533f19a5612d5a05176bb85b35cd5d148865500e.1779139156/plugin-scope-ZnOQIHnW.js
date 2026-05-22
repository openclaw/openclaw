//#region src/plugins/plugin-scope.ts
function normalizePluginIdScope(ids) {
	if (ids === void 0) return;
	return Array.from(new Set(ids.filter((id) => typeof id === "string").map((id) => id.trim()).filter(Boolean))).toSorted();
}
function hasExplicitPluginIdScope(ids) {
	return ids !== void 0;
}
function hasNonEmptyPluginIdScope(ids) {
	return ids !== void 0 && ids.length > 0;
}
function createPluginIdScopeSet(ids) {
	if (ids === void 0) return null;
	return new Set(ids);
}
function serializePluginIdScope(ids) {
	return ids === void 0 ? "__unscoped__" : JSON.stringify(ids);
}
//#endregion
export { serializePluginIdScope as a, normalizePluginIdScope as i, hasExplicitPluginIdScope as n, hasNonEmptyPluginIdScope as r, createPluginIdScopeSet as t };
