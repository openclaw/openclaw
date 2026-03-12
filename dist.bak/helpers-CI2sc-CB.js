//#region src/cli/program/helpers.ts
function collectOption(value, previous = []) {
	return [...previous, value];
}
function parsePositiveIntOrUndefined(value) {
	if (value === void 0 || value === null || value === "") return;
	if (typeof value === "number") {
		if (!Number.isFinite(value)) return;
		const parsed = Math.trunc(value);
		return parsed > 0 ? parsed : void 0;
	}
	if (typeof value === "string") {
		const parsed = Number.parseInt(value, 10);
		if (Number.isNaN(parsed) || parsed <= 0) return;
		return parsed;
	}
}
function resolveActionArgs(actionCommand) {
	if (!actionCommand) return [];
	const args = actionCommand.args;
	return Array.isArray(args) ? args : [];
}

//#endregion
export { parsePositiveIntOrUndefined as n, resolveActionArgs as r, collectOption as t };