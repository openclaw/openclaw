//#region src/shared/process-scoped-map.ts
function resolveProcessScopedMap(key) {
	const proc = process;
	const existing = proc[key];
	if (existing) return existing;
	const created = /* @__PURE__ */ new Map();
	proc[key] = created;
	return created;
}
//#endregion
export { resolveProcessScopedMap as t };
