import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { Dt as isRich, Et as colorize, Ot as theme, mn as shouldMigrateStateFromPath, ut as shortenHomePath } from "./entry.js";
import { N as readConfigFileSnapshot } from "./auth-profiles-D6H-HVV8.js";
import { t as formatCliCommand } from "./command-format-CDHXQh1_.js";
import { t as loadAndMaybeMigrateDoctorConfig } from "./doctor-config-flow-COa-e58k.js";

//#region src/cli/program/config-guard.ts
var config_guard_exports = /* @__PURE__ */ __exportAll({ ensureConfigReady: () => ensureConfigReady });
const ALLOWED_INVALID_COMMANDS = new Set([
	"doctor",
	"logs",
	"health",
	"help",
	"status"
]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
	"status",
	"probe",
	"health",
	"discover",
	"call",
	"install",
	"uninstall",
	"start",
	"stop",
	"restart"
]);
let didRunDoctorConfigFlow = false;
let configSnapshotPromise = null;
function formatConfigIssues(issues) {
	return issues.map((issue) => `- ${issue.path || "<root>"}: ${issue.message}`);
}
async function getConfigSnapshot() {
	if (process.env.VITEST === "true") return readConfigFileSnapshot();
	configSnapshotPromise ??= readConfigFileSnapshot();
	return configSnapshotPromise;
}
async function ensureConfigReady(params) {
	const commandPath = params.commandPath ?? [];
	if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
		didRunDoctorConfigFlow = true;
		await loadAndMaybeMigrateDoctorConfig({
			options: { nonInteractive: true },
			confirm: async () => false
		});
	}
	const snapshot = await getConfigSnapshot();
	const commandName = commandPath[0];
	const subcommandName = commandPath[1];
	const allowInvalid = commandName ? ALLOWED_INVALID_COMMANDS.has(commandName) || commandName === "gateway" && subcommandName && ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName) : false;
	const issues = snapshot.exists && !snapshot.valid ? formatConfigIssues(snapshot.issues) : [];
	const legacyIssues = snapshot.legacyIssues.length > 0 ? snapshot.legacyIssues.map((issue) => `- ${issue.path}: ${issue.message}`) : [];
	if (!(snapshot.exists && !snapshot.valid)) return;
	const rich = isRich();
	const muted = (value) => colorize(rich, theme.muted, value);
	const error = (value) => colorize(rich, theme.error, value);
	const heading = (value) => colorize(rich, theme.heading, value);
	const commandText = (value) => colorize(rich, theme.command, value);
	params.runtime.error(heading("Config invalid"));
	params.runtime.error(`${muted("File:")} ${muted(shortenHomePath(snapshot.path))}`);
	if (issues.length > 0) {
		params.runtime.error(muted("Problem:"));
		params.runtime.error(issues.map((issue) => `  ${error(issue)}`).join("\n"));
	}
	if (legacyIssues.length > 0) {
		params.runtime.error(muted("Legacy config keys detected:"));
		params.runtime.error(legacyIssues.map((issue) => `  ${error(issue)}`).join("\n"));
	}
	params.runtime.error("");
	params.runtime.error(`${muted("Run:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`);
	if (!allowInvalid) params.runtime.exit(1);
}

//#endregion
export { ensureConfigReady as n, config_guard_exports as t };