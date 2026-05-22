import { t as formatDocsLink } from "./links-p_GoHtCP.js";
import { r as theme } from "./theme-Clp64kpu.js";
import { t as addGatewayServiceCommands } from "./register-service-commands-DYh-sNLw.js";
import "./install-BvqvTdwm.js";
import "./lifecycle-DCJ0oflB.js";
import "./status-Cd1HjK36.js";
//#region src/cli/daemon-cli/register.ts
function registerDaemonCli(program) {
	addGatewayServiceCommands(program.command("daemon").description("Manage the Gateway service (launchd/systemd/schtasks)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`), { statusDescription: "Show service install status + probe connectivity/capability" });
}
//#endregion
export { registerDaemonCli as t };
