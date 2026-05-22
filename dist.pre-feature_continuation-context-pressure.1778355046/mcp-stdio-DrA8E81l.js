import { r as isDangerousHostEnvVarName } from "./host-env-security-CXDv4ev5.js";
//#region src/agents/mcp-config-shared.ts
function isMcpConfigRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function toMcpFilteredStringRecord(value, options) {
	if (!isMcpConfigRecord(value)) return;
	let droppedByKey = false;
	const entries = Object.entries(value).map(([key, entry]) => {
		if (options?.shouldDropKey?.(key)) {
			droppedByKey = true;
			options?.onDroppedEntry?.(key, entry);
			return null;
		}
		if (typeof entry === "string") return [key, entry];
		if (typeof entry === "number" || typeof entry === "boolean") return [key, String(entry)];
		options?.onDroppedEntry?.(key, entry);
		return null;
	}).filter((entry) => entry !== null);
	if (entries.length === 0 && droppedByKey && options?.preserveEmptyWhenKeysDropped) return {};
	return entries.length > 0 ? Object.fromEntries(entries) : void 0;
}
function toMcpStringRecord(value, options) {
	return toMcpFilteredStringRecord(value, options);
}
function toMcpEnvRecord(value, options) {
	return toMcpFilteredStringRecord(value, {
		...options,
		preserveEmptyWhenKeysDropped: true,
		shouldDropKey: (key) => isDangerousHostEnvVarName(key)
	});
}
function toMcpStringArray(value) {
	if (!Array.isArray(value)) return;
	const entries = value.filter((entry) => typeof entry === "string");
	return entries.length > 0 ? entries : [];
}
//#endregion
//#region src/agents/mcp-stdio.ts
function resolveStdioMcpServerLaunchConfig(raw, options) {
	if (!isMcpConfigRecord(raw)) return {
		ok: false,
		reason: "server config must be an object"
	};
	if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
		if (typeof raw.url === "string" && raw.url.trim().length > 0) return {
			ok: false,
			reason: "not a stdio server (has url)"
		};
		return {
			ok: false,
			reason: "its command is missing"
		};
	}
	const cwd = typeof raw.cwd === "string" && raw.cwd.trim().length > 0 ? raw.cwd : typeof raw.workingDirectory === "string" && raw.workingDirectory.trim().length > 0 ? raw.workingDirectory : void 0;
	return {
		ok: true,
		config: {
			command: raw.command,
			args: toMcpStringArray(raw.args),
			env: toMcpEnvRecord(raw.env, { onDroppedEntry: options?.onDroppedEnv }),
			cwd
		}
	};
}
function describeStdioMcpServerLaunchConfig(config) {
	const args = Array.isArray(config.args) && config.args.length > 0 ? ` ${config.args.join(" ")}` : "";
	const cwd = config.cwd ? ` (cwd=${config.cwd})` : "";
	return `${config.command}${args}${cwd}`;
}
//#endregion
export { toMcpStringRecord as i, resolveStdioMcpServerLaunchConfig as n, isMcpConfigRecord as r, describeStdioMcpServerLaunchConfig as t };
