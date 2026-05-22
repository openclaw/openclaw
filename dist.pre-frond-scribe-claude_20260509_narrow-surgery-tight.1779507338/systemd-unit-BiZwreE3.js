import { t as splitArgsPreservingQuotes } from "./arg-split-DM7vx6uc.js";
//#region src/daemon/systemd-unit.ts
const SYSTEMD_LINE_BREAKS = /[\r\n]/;
function assertNoSystemdLineBreaks(value, label) {
	if (SYSTEMD_LINE_BREAKS.test(value)) throw new Error(`${label} cannot contain CR or LF characters.`);
}
function systemdEscapeArg(value) {
	assertNoSystemdLineBreaks(value, "Systemd unit values");
	if (!/[\s"\\]/.test(value)) return value;
	return `"${value.replace(/\\\\/g, "\\\\\\\\").replace(/"/g, "\\\\\"")}"`;
}
function renderEnvLines(env) {
	if (!env) return [];
	const entries = Object.entries(env).filter(([, value]) => typeof value === "string" && value.trim());
	if (entries.length === 0) return [];
	return entries.map(([key, value]) => {
		const rawValue = value ?? "";
		assertNoSystemdLineBreaks(key, "Systemd environment variable names");
		assertNoSystemdLineBreaks(rawValue, "Systemd environment variable values");
		return `Environment=${systemdEscapeArg(`${key}=${rawValue.trim()}`)}`;
	});
}
function renderEnvironmentFileLines(environmentFiles) {
	if (!environmentFiles) return [];
	return environmentFiles.map((entry) => entry.trim()).filter(Boolean).map((entry) => {
		assertNoSystemdLineBreaks(entry, "Systemd EnvironmentFile values");
		return `EnvironmentFile=-${systemdEscapeArg(entry)}`;
	});
}
function buildSystemdUnit({ description, programArguments, workingDirectory, environment, environmentFiles }) {
	const execStart = programArguments.map(systemdEscapeArg).join(" ");
	const descriptionValue = description?.trim() || "OpenClaw Gateway";
	assertNoSystemdLineBreaks(descriptionValue, "Systemd Description");
	const descriptionLine = `Description=${descriptionValue}`;
	const workingDirLine = workingDirectory ? `WorkingDirectory=${systemdEscapeArg(workingDirectory)}` : null;
	const envLines = renderEnvLines(environment);
	const environmentFileLines = renderEnvironmentFileLines(environmentFiles);
	return [
		"[Unit]",
		descriptionLine,
		"After=network-online.target",
		"Wants=network-online.target",
		"StartLimitBurst=5",
		"StartLimitIntervalSec=60",
		"",
		"[Service]",
		`ExecStart=${execStart}`,
		"Restart=always",
		"RestartSec=5",
		"RestartPreventExitStatus=78",
		"TimeoutStopSec=30",
		"TimeoutStartSec=30",
		"SuccessExitStatus=0 143",
		"KillMode=control-group",
		workingDirLine,
		...environmentFileLines,
		...envLines,
		"",
		"[Install]",
		"WantedBy=default.target",
		""
	].filter((line) => line !== null).join("\n");
}
function parseSystemdExecStart(value) {
	return splitArgsPreservingQuotes(value, { escapeMode: "backslash" });
}
function parseSystemdEnvAssignment(raw) {
	const trimmed = raw.trim();
	if (!trimmed) return null;
	const unquoted = (() => {
		const quote = trimmed[0];
		if (!((quote === "\"" || quote === "'") && trimmed.endsWith(quote))) return trimmed;
		let out = "";
		let escapeNext = false;
		for (const ch of trimmed.slice(1, -1)) {
			if (escapeNext) {
				out += ch;
				escapeNext = false;
				continue;
			}
			if (ch === "\\\\") {
				escapeNext = true;
				continue;
			}
			out += ch;
		}
		return out;
	})();
	const eq = unquoted.indexOf("=");
	if (eq <= 0) return null;
	const key = unquoted.slice(0, eq).trim();
	if (!key) return null;
	return {
		key,
		value: unquoted.slice(eq + 1)
	};
}
function parseSystemdEnvAssignments(raw) {
	return splitArgsPreservingQuotes(raw, {
		escapeMode: "backslash",
		quoteChars: ["\"", "'"],
		quoteStart: "item-start"
	}).flatMap((entry) => {
		const parsed = parseSystemdEnvAssignment(entry);
		return parsed ? [parsed] : [];
	});
}
function renderSystemdEnvAssignment(key, value) {
	return systemdEscapeArg(`${key}=${value}`);
}
//#endregion
export { renderSystemdEnvAssignment as a, parseSystemdExecStart as i, parseSystemdEnvAssignment as n, parseSystemdEnvAssignments as r, buildSystemdUnit as t };
