import { t as splitArgsPreservingQuotes } from "./arg-split-D6fUeLBa.js";
//#region src/daemon/cmd-set.ts
function assertNoCmdLineBreak(value, field) {
	if (/[\r\n]/.test(value)) throw new Error(`${field} cannot contain CR or LF in Windows task scripts.`);
}
function escapeCmdSetAssignmentComponent(value) {
	return value.replace(/\^/g, "^^").replace(/%/g, "%%").replace(/!/g, "^!").replace(/"/g, "^\"");
}
function unescapeCmdSetAssignmentComponent(value) {
	let out = "";
	for (let i = 0; i < value.length; i += 1) {
		const ch = value[i];
		const next = value[i + 1];
		if (ch === "^" && (next === "^" || next === "\"" || next === "!")) {
			out += next;
			i += 1;
			continue;
		}
		if (ch === "%" && next === "%") {
			out += "%";
			i += 1;
			continue;
		}
		out += ch;
	}
	return out;
}
function parseCmdSetAssignment(line) {
	const raw = line.trim();
	if (!raw) return null;
	const quoted = raw.startsWith("\"") && raw.endsWith("\"") && raw.length >= 2;
	const assignment = quoted ? raw.slice(1, -1) : raw;
	const index = assignment.indexOf("=");
	if (index <= 0) return null;
	const key = assignment.slice(0, index).trim();
	const value = assignment.slice(index + 1).trim();
	if (!key) return null;
	if (!quoted) return {
		key,
		value
	};
	return {
		key: unescapeCmdSetAssignmentComponent(key),
		value: unescapeCmdSetAssignmentComponent(value)
	};
}
function renderCmdSetAssignment(key, value) {
	assertNoCmdLineBreak(key, "Environment variable name");
	assertNoCmdLineBreak(value, "Environment variable value");
	return `set "${escapeCmdSetAssignmentComponent(key)}=${escapeCmdSetAssignmentComponent(value)}"`;
}
//#endregion
//#region src/daemon/cmd-argv.ts
function quoteCmdScriptArg(value) {
	assertNoCmdLineBreak(value, "Command argument");
	if (!value) return "\"\"";
	const escaped = value.replace(/"/g, "\\\"").replace(/%/g, "%%").replace(/!/g, "^!");
	if (!/[ \t"&|<>^()%!]/g.test(value)) return escaped;
	return `"${escaped}"`;
}
function unescapeCmdScriptArg(value) {
	return value.replace(/\^!/g, "!").replace(/%%/g, "%");
}
function parseCmdScriptCommandLine(value) {
	return splitArgsPreservingQuotes(value, { escapeMode: "backslash-quote-only" }).map(unescapeCmdScriptArg);
}
//#endregion
export { renderCmdSetAssignment as a, parseCmdSetAssignment as i, quoteCmdScriptArg as n, assertNoCmdLineBreak as r, parseCmdScriptCommandLine as t };
