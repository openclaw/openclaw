import { t as resolveCliArgvInvocation } from "./argv-invocation-C7Tq1otP.js";
import { n as VERSION } from "./version-CQfgAE7_.js";
import { t as configureProgramHelp } from "./help-CVl-B0qJ.js";
import { Command } from "commander";
//#region src/cli/setup-onboard-configure-help-fast-path.ts
const SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS = new Set([
	"setup",
	"onboard",
	"configure"
]);
function isCommanderParseExit(error) {
	if (!error || typeof error !== "object") return false;
	const candidate = error;
	return typeof candidate.exitCode === "number" && Number.isInteger(candidate.exitCode) && typeof candidate.code === "string" && candidate.code.startsWith("commander.");
}
function resolveSetupOnboardConfigureHelpCommand(argv) {
	const invocation = resolveCliArgvInvocation(argv);
	if (invocation.commandPath.length !== 1 || !invocation.hasHelpOrVersion) return null;
	const command = invocation.commandPath[0];
	return SETUP_ONBOARD_CONFIGURE_HELP_COMMANDS.has(command) ? command : null;
}
function createHelpContext() {
	return {
		programVersion: VERSION,
		channelOptions: [],
		messageChannelOptions: "",
		agentChannelOptions: "last"
	};
}
async function registerHelpCommand(program, command) {
	if (command === "setup") {
		const { registerSetupCommand } = await import("./register.setup-DqANN7YL.js");
		registerSetupCommand(program);
		return;
	}
	if (command === "onboard") {
		const { registerOnboardCommand } = await import("./register.onboard-DrdcyI8k.js");
		registerOnboardCommand(program);
		return;
	}
	const { registerConfigureCommand } = await import("./register.configure-D-jtBxhU.js");
	registerConfigureCommand(program);
}
async function tryOutputSetupOnboardConfigureHelp(argv) {
	const command = resolveSetupOnboardConfigureHelpCommand(argv);
	if (!command) return false;
	const program = new Command();
	program.enablePositionalOptions();
	program.exitOverride((err) => {
		process.exitCode = typeof err.exitCode === "number" ? err.exitCode : 1;
		throw err;
	});
	configureProgramHelp(program, createHelpContext());
	await registerHelpCommand(program, command);
	try {
		await program.parseAsync(argv);
	} catch (error) {
		if (!isCommanderParseExit(error)) throw error;
		process.exitCode = error.exitCode;
	}
	return true;
}
//#endregion
export { tryOutputSetupOnboardConfigureHelp };
