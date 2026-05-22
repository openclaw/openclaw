import { t as formatDocsLink } from "./links-p_GoHtCP.js";
import { r as theme } from "./theme-Clp64kpu.js";
import { n as defaultRuntime } from "./runtime-Bd9_VI2J.js";
import { n as runCommandWithRuntime } from "./cli-utils-CnfFuGmf.js";
import { r as CONFIGURE_WIZARD_SECTIONS, t as configureCommandFromSectionsArg } from "./configure-CEP-evHA.js";
//#region src/cli/program/register.configure.ts
function registerConfigureCommand(program) {
	program.command("configure").description("Interactive configuration for credentials, channels, gateway, and agent defaults").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/configure", "docs.openclaw.ai/cli/configure")}\n`).option("--section <section>", `Configuration sections (repeatable). Options: ${CONFIGURE_WIZARD_SECTIONS.join(", ")}`, (value, previous) => [...previous, value], []).action(async (opts) => {
		await runCommandWithRuntime(defaultRuntime, async () => {
			await configureCommandFromSectionsArg(opts.section, defaultRuntime);
		});
	});
}
//#endregion
export { registerConfigureCommand };
