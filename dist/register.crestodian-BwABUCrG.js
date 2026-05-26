import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as runCrestodian } from "./crestodian-DP-qzfe5.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import { t as formatHelpExamples } from "./help-format-DXVAk021.js";
//#region src/cli/program/register.crestodian.ts
function registerCrestodianCommand(program) {
	program.command("crestodian").description("Open the ring-zero setup and repair helper").option("-m, --message <text>", "Run one Crestodian request").option("--yes", "Approve persistent config writes for this request", false).option("--json", "Output startup overview as JSON", false).addHelpText("after", () => `\n${theme.heading("Examples:")}\n${formatHelpExamples([
		["openclaw", "Start Crestodian."],
		["openclaw crestodian", "Start Crestodian explicitly."],
		["openclaw crestodian -m \"status\"", "Run one status request."],
		["openclaw crestodian -m \"set default model openai/gpt-5.2\" --yes", "Apply a typed config write."]
	])}`).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await runCrestodian({
				message: opts.message,
				yes: Boolean(opts.yes),
				json: Boolean(opts.json)
			});
		});
	});
}
//#endregion
export { registerCrestodianCommand };
