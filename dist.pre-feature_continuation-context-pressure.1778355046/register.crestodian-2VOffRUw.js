import { r as theme } from "./theme-CVJvORNs.js";
import { n as defaultRuntime } from "./runtime-bzt9CHmD.js";
import { t as runCrestodian } from "./crestodian-B_kBmCb2.js";
import { n as runCommandWithRuntime } from "./cli-utils-Bm4scV9c.js";
import { t as formatHelpExamples } from "./help-format-M6OA6DMb.js";
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
