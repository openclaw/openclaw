import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
import { n as CONFIGURE_WIZARD_SECTIONS } from "./configure.shared-C2Fyjm61.js";
//#region src/cli/program/register.configure.ts
function registerConfigureCommand(program) {
	program.command("configure").description("Interactive configuration for credentials, channels, gateway, and agent defaults").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/configure", "docs.openclaw.ai/cli/configure")}\n`).option("--section <section>", `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`, (value, previous) => [...previous, value], []).action(async (opts) => {
		const { defaultRuntime } = await import("./runtime-DRhjCMq8.js");
		await runCommandWithRuntime(defaultRuntime, async () => {
			const { configureCommandFromSectionsArg } = await import("./configure.commands-Bux3ZUmS.js");
			await configureCommandFromSectionsArg(opts.section, defaultRuntime);
		});
	});
}
//#endregion
export { registerConfigureCommand };
