import "./paths-BBP4yd-2.js";
import { h as theme } from "./globals-DBA9iEt5.js";
import "./utils-BgHhhQlR.js";
import "./agent-scope-DcOd8osz.js";
import "./subsystem-B6NrUFrh.js";
import "./openclaw-root-rLmdSaR4.js";
import "./logger-JY9zcN88.js";
import "./exec-DOBmQ145.js";
import "./model-selection-COYmqEoi.js";
import "./registry-DBb6KIXY.js";
import "./github-copilot-token-D9l3eOWF.js";
import "./boolean-C6Pbt2Ue.js";
import "./env-BfNMiMlQ.js";
import "./manifest-registry-BS8o_I_L.js";
import "./runtime-overrides-COUAbg1N.js";
import "./message-channel-BTTrmWeS.js";
import "./tailnet-ZGehJquv.js";
import "./ws-C0C8fn9j.js";
import "./client-e8ddTB8a.js";
import "./call-D_7yp3J2.js";
import "./pairing-token-B9SSCi9X.js";
import "./runtime-config-collectors-B1e_OiHD.js";
import "./command-secret-targets-OLgKF2ja.js";
import { t as formatDocsLink } from "./links-DgCV6JAm.js";
import { n as registerQrCli } from "./qr-cli-BdEqj6-T.js";

//#region src/cli/clawbot-cli.ts
function registerClawbotCli(program) {
	registerQrCli(program.command("clawbot").description("Legacy clawbot command aliases").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/clawbot", "docs.openclaw.ai/cli/clawbot")}\n`));
}

//#endregion
export { registerClawbotCli };