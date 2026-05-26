import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { t as hasExplicitOptions } from "./command-options-Dhjl7AMa.js";
import { n as runCommandWithRuntime } from "./cli-utils-CdDa8OYO.js";
//#region src/cli/program/register.setup.ts
function registerSetupCommand(program) {
	program.command("setup").description("Create baseline config/workspace files; use --wizard for full onboarding").addHelpText("after", () => `\n${theme.heading("Examples:")}\n  ${theme.command("openclaw setup")}\n    ${theme.muted("Create config, workspace, and session folders.")}\n  ${theme.command("openclaw setup --wizard")}\n    ${theme.muted("Run full onboarding for auth, models, Gateway, and channels.")}\n\n${theme.muted("Docs:")} ${formatDocsLink("/cli/setup", "docs.openclaw.ai/cli/setup")}\n`).option("--workspace <dir>", "Agent workspace directory (default: ~/.openclaw/workspace; stored as agents.defaults.workspace)").option("--wizard", "Run interactive onboarding", false).option("--non-interactive", "Run onboarding without prompts", false).option("--mode <mode>", "Onboard mode: local|remote").option("--import-from <provider>", "Migration provider to run during onboarding").option("--import-source <path>", "Source agent home for --import-from").option("--import-secrets", "Import supported secrets during onboarding migration", false).option("--remote-url <url>", "Remote Gateway WebSocket URL").option("--remote-token <token>", "Remote Gateway token (optional)").action(async (opts, command) => {
		const { defaultRuntime } = await import("./runtime-DRhjCMq8.js");
		await runCommandWithRuntime(defaultRuntime, async () => {
			const hasWizardFlags = hasExplicitOptions(command, [
				"wizard",
				"nonInteractive",
				"mode",
				"importFrom",
				"importSource",
				"importSecrets",
				"remoteUrl",
				"remoteToken"
			]);
			if (opts.wizard || hasWizardFlags) {
				const { setupWizardCommand } = await import("./onboard-CePsejdX.js");
				await setupWizardCommand({
					workspace: opts.workspace,
					nonInteractive: Boolean(opts.nonInteractive),
					mode: opts.mode,
					importFrom: opts.importFrom,
					importSource: opts.importSource,
					importSecrets: Boolean(opts.importSecrets),
					remoteUrl: opts.remoteUrl,
					remoteToken: opts.remoteToken
				}, defaultRuntime);
				return;
			}
			const { setupCommand } = await import("./setup-eaG_JNIP.js");
			await setupCommand({ workspace: opts.workspace }, defaultRuntime);
		});
	});
}
//#endregion
export { registerSetupCommand };
