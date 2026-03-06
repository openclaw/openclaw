import "./paths-BBP4yd-2.js";
import { h as theme } from "./globals-DBA9iEt5.js";
import "./utils-BgHhhQlR.js";
import "./agent-scope-DcOd8osz.js";
import "./subsystem-B6NrUFrh.js";
import "./openclaw-root-rLmdSaR4.js";
import "./logger-JY9zcN88.js";
import "./exec-DOBmQ145.js";
import "./model-selection-Dmiyt9yA.js";
import "./registry-DBb6KIXY.js";
import "./github-copilot-token-D9l3eOWF.js";
import "./boolean-C6Pbt2Ue.js";
import "./env-BfNMiMlQ.js";
import "./manifest-registry-BS8o_I_L.js";
import "./runtime-overrides-COUAbg1N.js";
import "./message-channel-BTTrmWeS.js";
import "./tailnet-BlWYu4Vr.js";
import "./ws-OMv8Zfui.js";
import "./client-0WVSaq6Z.js";
import "./call-Cc2tK_jb.js";
import "./pairing-token-B9SSCi9X.js";
import "./runtime-config-collectors-Br4rNJT_.js";
import "./command-secret-targets-CpHvX-8c.js";
import { t as formatDocsLink } from "./links-DgCV6JAm.js";
import { n as registerQrCli } from "./qr-cli-C1Glz1s_.js";

//#region src/cli/clawbot-cli.ts
function registerClawbotCli(program) {
	registerQrCli(program.command("clawbot").description("Legacy clawbot command aliases").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/clawbot", "docs.openclaw.ai/cli/clawbot")}\n`));
}

//#endregion
export { registerClawbotCli };