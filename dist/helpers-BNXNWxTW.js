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
function isDefaultOptionValue(command, name) {
	if (typeof command.getOptionValueSource !== "function") return false;
	return command.getOptionValueSource(name) === "default";
}
function appendOptionValue(out, flag, value) {
	if (value === void 0) return;
	if (value === false) {
		if (flag.startsWith("--no-")) out.push(flag);
		return;
	}
	if (value === true) {
		out.push(flag);
		return;
	}
	const arg = stringifyOptionValue(value);
	if (arg !== void 0) out.push(flag, arg);
}
function stringifyOptionValue(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" && Number.isFinite(value)) return String(value);
	if (typeof value === "bigint") return value.toString();
}
function resolveCommandOptionArgs(command) {
	if (!command) return [];
	const out = [];
	for (const option of command.options) {
		const name = option.attributeName();
		if (isDefaultOptionValue(command, name)) continue;
		const flag = option.long ?? option.short;
		if (!flag) continue;
		const value = command.getOptionValue(name);
		if (Array.isArray(value)) {
			for (const item of value) appendOptionValue(out, flag, item);
			continue;
		}
		appendOptionValue(out, flag, value);
	}
	return out;
}
//#endregion
export { resolveCommandOptionArgs as i, parsePositiveIntOrUndefined as n, resolveActionArgs as r, collectOption as t };
