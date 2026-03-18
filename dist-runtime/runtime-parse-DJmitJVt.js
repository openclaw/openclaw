import { i as theme, n as init_theme, r as isRich, t as colorize } from "./theme-CL08MjAq.js";
import { u as resolveGatewayProfileSuffix } from "./constants-C8ub4F0Y.js";
import path from "node:path";
import { execFile } from "node:child_process";
//#region src/daemon/exec-file.ts
async function execFileUtf8(command, args, options = {}) {
	return await new Promise((resolve) => {
		execFile(command, args, {
			...options,
			encoding: "utf8"
		}, (error, stdout, stderr) => {
			if (!error) {
				resolve({
					stdout: String(stdout ?? ""),
					stderr: String(stderr ?? ""),
					code: 0
				});
				return;
			}
			const e = error;
			const stderrText = String(stderr ?? "");
			resolve({
				stdout: String(stdout ?? ""),
				stderr: stderrText || (typeof e.message === "string" ? e.message : typeof error === "string" ? error : ""),
				code: typeof e.code === "number" ? e.code : 1
			});
		});
	});
}
//#endregion
//#region src/daemon/output.ts
init_theme();
const toPosixPath = (value) => value.replace(/\\/g, "/");
function formatLine(label, value) {
	const rich = isRich();
	return `${colorize(rich, theme.muted, `${label}:`)} ${colorize(rich, theme.command, value)}`;
}
function writeFormattedLines(stdout, lines, opts) {
	if (opts?.leadingBlankLine) stdout.write("\n");
	for (const line of lines) stdout.write(`${formatLine(line.label, line.value)}\n`);
}
//#endregion
//#region src/daemon/paths.ts
const windowsAbsolutePath = /^[a-zA-Z]:[\\/]/;
const windowsUncPath = /^\\\\/;
function resolveHomeDir(env) {
	const home = env.HOME?.trim() || env.USERPROFILE?.trim();
	if (!home) throw new Error("Missing HOME");
	return home;
}
function resolveUserPathWithHome(input, home) {
	const trimmed = input.trim();
	if (!trimmed) return trimmed;
	if (trimmed.startsWith("~")) {
		if (!home) throw new Error("Missing HOME");
		const expanded = trimmed.replace(/^~(?=$|[\\/])/, home);
		return path.resolve(expanded);
	}
	if (windowsAbsolutePath.test(trimmed) || windowsUncPath.test(trimmed)) return trimmed;
	return path.resolve(trimmed);
}
function resolveGatewayStateDir(env) {
	const override = env.OPENCLAW_STATE_DIR?.trim();
	if (override) return resolveUserPathWithHome(override, override.startsWith("~") ? resolveHomeDir(env) : void 0);
	const home = resolveHomeDir(env);
	const suffix = resolveGatewayProfileSuffix(env.OPENCLAW_PROFILE);
	return path.join(home, `.openclaw${suffix}`);
}
//#endregion
//#region src/daemon/runtime-parse.ts
function parseKeyValueOutput(output, separator) {
	const entries = {};
	for (const rawLine of output.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line) continue;
		const idx = line.indexOf(separator);
		if (idx <= 0) continue;
		const key = line.slice(0, idx).trim().toLowerCase();
		if (!key) continue;
		entries[key] = line.slice(idx + separator.length).trim();
	}
	return entries;
}
//#endregion
export { toPosixPath as a, formatLine as i, resolveGatewayStateDir as n, writeFormattedLines as o, resolveHomeDir as r, execFileUtf8 as s, parseKeyValueOutput as t };
