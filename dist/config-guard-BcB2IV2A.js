import { p as shouldMigrateStateFromPath } from "./argv-BHL8kwwH.js";
import { u as readConfigFileSnapshot } from "./io-5xE1dPMK.js";
import { _ as setRuntimeConfigSnapshot } from "./runtime-snapshot-tLK3Mx7y.js";
import "./config-CzeRK-GW.js";
//#region src/cli/program/config-guard.ts
const ALLOWED_INVALID_COMMANDS = new Set([
	"doctor",
	"logs",
	"health",
	"help",
	"status"
]);
const ALLOWED_INVALID_GATEWAY_SUBCOMMANDS = new Set([
	"run",
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
function resetConfigGuardStateForTests() {
	didRunDoctorConfigFlow = false;
	configSnapshotPromise = null;
}
async function getConfigSnapshot() {
	if (process.env.VITEST === "true") return readConfigFileSnapshot();
	configSnapshotPromise ??= readConfigFileSnapshot();
	return configSnapshotPromise;
}
async function ensureConfigReady(params) {
	const commandPath = params.commandPath ?? [];
	let preflightSnapshot = null;
	if (!didRunDoctorConfigFlow && shouldMigrateStateFromPath(commandPath)) {
		didRunDoctorConfigFlow = true;
		const runDoctorConfigPreflight = async () => (await import("./doctor-config-preflight-CK46356c.js")).runDoctorConfigPreflight({
			migrateState: false,
			migrateLegacyConfig: false,
			invalidConfigNote: false
		});
		if (!params.suppressDoctorStdout) preflightSnapshot = (await runDoctorConfigPreflight()).snapshot;
		else {
			const originalStdoutWrite = process.stdout.write.bind(process.stdout);
			const originalSuppressNotes = process.env.OPENCLAW_SUPPRESS_NOTES;
			process.stdout.write = (() => true);
			process.env.OPENCLAW_SUPPRESS_NOTES = "1";
			try {
				preflightSnapshot = (await runDoctorConfigPreflight()).snapshot;
			} finally {
				process.stdout.write = originalStdoutWrite;
				if (originalSuppressNotes === void 0) delete process.env.OPENCLAW_SUPPRESS_NOTES;
				else process.env.OPENCLAW_SUPPRESS_NOTES = originalSuppressNotes;
			}
		}
	}
	const snapshot = preflightSnapshot ?? await getConfigSnapshot();
	const commandName = commandPath[0];
	const subcommandName = commandPath[1];
	const isBareGatewayForegroundRun = commandName === "gateway" && (subcommandName === void 0 || subcommandName.trim() === "");
	const allowInvalid = commandName ? params.allowInvalid === true || ALLOWED_INVALID_COMMANDS.has(commandName) || isBareGatewayForegroundRun || commandName === "gateway" && subcommandName && ALLOWED_INVALID_GATEWAY_SUBCOMMANDS.has(subcommandName) : false;
	const { formatConfigIssueLines } = await import("./issue-format-AE7x_CkE.js");
	const issues = snapshot.exists && !snapshot.valid ? formatConfigIssueLines(snapshot.issues, "-", { normalizeRoot: true }) : [];
	const legacyIssues = snapshot.legacyIssues.length > 0 ? formatConfigIssueLines(snapshot.legacyIssues, "-") : [];
	const invalid = snapshot.exists && !snapshot.valid;
	if (!invalid) setRuntimeConfigSnapshot(snapshot.runtimeConfig ?? snapshot.config, snapshot.sourceConfig);
	if (!invalid) return;
	const [{ colorize, isRich, theme }, { shortenHomePath }, { formatCliCommand }] = await Promise.all([
		import("./theme-By-25q-O.js"),
		import("./utils-Dhe1Vaw_.js"),
		import("./command-format-oW9EVHvc.js")
	]);
	const rich = isRich();
	const muted = (value) => colorize(rich, theme.muted, value);
	const error = (value) => colorize(rich, theme.error, value);
	const heading = (value) => colorize(rich, theme.heading, value);
	const commandText = (value) => colorize(rich, theme.command, value);
	params.runtime.error(heading("OpenClaw config is invalid"));
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
	params.runtime.error(`${muted("Fix:")} ${commandText(formatCliCommand("openclaw doctor --fix"))}`);
	params.runtime.error(`${muted("Inspect:")} ${commandText(formatCliCommand("openclaw config validate"))}`);
	params.runtime.error(muted("Status, health, logs, and doctor commands still run with invalid config."));
	if (!allowInvalid) params.runtime.exit(1);
}
const __test__ = { resetConfigGuardStateForTests };
//#endregion
export { __test__, ensureConfigReady };
