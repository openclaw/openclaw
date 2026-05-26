//#region src/plugins/module-export.ts
function unwrapDefaultModuleExport(moduleExport) {
	let resolved = moduleExport;
	const seen = /* @__PURE__ */ new Set();
	while (resolved && typeof resolved === "object" && "default" in resolved && !seen.has(resolved)) {
		seen.add(resolved);
		resolved = resolved.default;
	}
	return resolved;
}
//#endregion
export { unwrapDefaultModuleExport as t };
