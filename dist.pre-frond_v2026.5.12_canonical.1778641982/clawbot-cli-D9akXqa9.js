import { t as formatDocsLink } from "./links-dQIIPEtq.js";
import { r as theme } from "./theme-CVJvORNs.js";
import { t as registerQrCli } from "./qr-cli-Tc_ypLuL.js";
//#region src/cli/clawbot-cli.ts
function registerClawbotCli(program) {
	registerQrCli(program.command("clawbot").description("Legacy clawbot command aliases").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/clawbot", "docs.openclaw.ai/cli/clawbot")}\n`));
}
//#endregion
export { registerClawbotCli };
