import { h as theme } from "./globals-DqM7Q4km.js";
import "./paths-BMo6kTge.js";
import "./subsystem-BXiL6bA6.js";
import "./boolean-DtWR5bt3.js";
import "./auth-profiles-B1fxmUx1.js";
import "./agent-scope-BXg6mLAy.js";
import "./utils-xLjEf_5u.js";
import "./openclaw-root-CUjRHZhy.js";
import "./logger-hujp-3PD.js";
import "./exec-BpP6Q4EB.js";
import "./registry-DTmGzx3d.js";
import "./github-copilot-token-CvN6iidT.js";
import "./manifest-registry-YpcF6BWJ.js";
import "./version-cke7D5Ak.js";
import "./runtime-overrides-ChuaKEss.js";
import "./message-channel-Uz3-Q9E0.js";
import "./client-DCYSexfL.js";
import "./call-NWndvBdo.js";
import "./pairing-token-BXrId5bQ.js";
import "./net-B5SHg7yf.js";
import "./tailnet-c-aDu2yD.js";
import "./runtime-config-collectors-C448f2WD.js";
import "./command-secret-targets-BR6DP2Oq.js";
import { t as formatDocsLink } from "./links-dO-svE2W.js";
import { n as registerQrCli } from "./qr-cli-Bdzwi9Jn.js";

//#region src/cli/clawbot-cli.ts
function registerClawbotCli(program) {
	registerQrCli(program.command("clawbot").description("Legacy clawbot command aliases").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/clawbot", "docs.openclaw.ai/cli/clawbot")}\n`));
}

//#endregion
export { registerClawbotCli };