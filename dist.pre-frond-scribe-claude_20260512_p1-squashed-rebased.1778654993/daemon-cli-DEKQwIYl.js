import { t as formatDocsLink } from "./links-p_GoHtCP.js";
import { r as theme } from "./theme-Clp64kpu.js";
import { t as addGatewayServiceCommands } from "./register-service-commands-BszWysDC.js";
import "./install-CuGuOUrv.js";
import "./lifecycle-DBMy9oWV.js";
import "./status-563zVXuK.js";
//#region src/cli/daemon-cli/register.ts
function registerDaemonCli(program) {
	addGatewayServiceCommands(program.command("daemon").description("Manage the Gateway service (launchd/systemd/schtasks)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`), { statusDescription: "Show service install status + probe connectivity/capability" });
}
//#endregion
export { registerDaemonCli as t };
