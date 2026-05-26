//#region src/plugin-sdk/approval-approvers.ts
function dedupeDefined(values) {
	const resolved = /* @__PURE__ */ new Set();
	for (const value of values) {
		if (!value) continue;
		resolved.add(value);
	}
	return [...resolved];
}
function resolveApprovalApprovers(params) {
	const explicit = dedupeDefined((params.explicit ?? []).map((entry) => params.normalizeApprover(entry)));
	if (explicit.length > 0) return explicit;
	return dedupeDefined([
		...(params.allowFrom ?? []).map((entry) => params.normalizeApprover(entry)),
		...(params.extraAllowFrom ?? []).map((entry) => params.normalizeApprover(entry)),
		...params.defaultTo?.trim() ? [(params.normalizeDefaultTo ?? ((value) => params.normalizeApprover(value)))(params.defaultTo.trim())] : []
	]);
}
//#endregion
export { resolveApprovalApprovers as t };
