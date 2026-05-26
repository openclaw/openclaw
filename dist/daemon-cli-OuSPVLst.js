import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { t as addGatewayServiceCommands } from "./register-service-commands-C00VMLUa.js";
import "./install-Coi9OZZp.js";
import "./lifecycle-pzqT7s2v.js";
import "./status-DN14tCRc.js";
//#region src/cli/daemon-cli/register.ts
function registerDaemonCli(program) {
	addGatewayServiceCommands(program.command("daemon").description("Manage the Gateway service (launchd/systemd/schtasks)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/gateway", "docs.openclaw.ai/cli/gateway")}\n`), { statusDescription: "Show service install status + probe connectivity/capability" });
}
//#endregion
export { registerDaemonCli as t };
