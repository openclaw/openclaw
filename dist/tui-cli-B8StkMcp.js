import "./paths-BBP4yd-2.js";
import { h as theme } from "./globals-DBA9iEt5.js";
import "./utils-BgHhhQlR.js";
import "./thinking-44rmAw5o.js";
import "./agent-scope-DcOd8osz.js";
import { d as defaultRuntime } from "./subsystem-B6NrUFrh.js";
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
import "./dock-D67Q8hqq.js";
import "./message-channel-BTTrmWeS.js";
import "./plugins-CVNXMV8f.js";
import "./sessions-oRavjpc9.js";
import "./pi-embedded-helpers-BLQrSaGN.js";
import "./sandbox-j3i-A46n.js";
import "./tool-catalog-IBWCA-2a.js";
import "./chrome-DGhZwihE.js";
import "./tailscale-CuFyx_x9.js";
import "./tailnet-BlWYu4Vr.js";
import "./ws-OMv8Zfui.js";
import "./auth-CwHPKzRu.js";
import "./server-context-CVdBixsK.js";
import "./frontmatter-DobVhJLD.js";
import "./skills-DOWW7Nlf.js";
import "./path-alias-guards-DHN0MYP9.js";
import "./paths-L5nChQ8H.js";
import "./redact-BIlIgsBb.js";
import "./errors-DRE3vN3Q.js";
import "./fs-safe-CAprtaTc.js";
import "./proxy-env-Bs1PClUZ.js";
import "./image-ops-_Momh5Q_.js";
import "./store-B8nZst-N.js";
import "./ports-dE92jbnn.js";
import "./trash-CJfp7H-I.js";
import "./server-middleware-UmRI5cjA.js";
import "./accounts-DXxZARtQ.js";
import "./accounts-Z1bz-0gv.js";
import "./logging-CZCkEw2g.js";
import "./accounts-RlQcOaUI.js";
import "./paths-J0EFKbLQ.js";
import "./chat-envelope-BZKQmhVe.js";
import "./tool-images-CxRDpS1l.js";
import "./tool-display-oPtLgvHX.js";
import "./commands-BrTU55I1.js";
import "./commands-registry-BZHYLk3Q.js";
import "./client-0WVSaq6Z.js";
import "./call-Cc2tK_jb.js";
import "./pairing-token-B9SSCi9X.js";
import { t as formatDocsLink } from "./links-DgCV6JAm.js";
import { t as parseTimeoutMs } from "./parse-timeout-ntOahNdf.js";
import "./resolve-configured-secret-input-string-j4LyjuXR.js";
import { t as runTui } from "./tui-C21XGrt6.js";

//#region src/cli/tui-cli.ts
function registerTuiCli(program) {
	program.command("tui").description("Open a terminal UI connected to the Gateway").option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (if required)").option("--session <key>", "Session key (default: \"main\", or \"global\" when scope is global)").option("--deliver", "Deliver assistant replies", false).option("--thinking <level>", "Thinking level override").option("--message <text>", "Send an initial message after connecting").option("--timeout-ms <ms>", "Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)").option("--history-limit <n>", "History entries to load", "200").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/tui", "docs.openclaw.ai/cli/tui")}\n`).action(async (opts) => {
		try {
			const timeoutMs = parseTimeoutMs(opts.timeoutMs);
			if (opts.timeoutMs !== void 0 && timeoutMs === void 0) defaultRuntime.error(`warning: invalid --timeout-ms "${String(opts.timeoutMs)}"; ignoring`);
			const historyLimit = Number.parseInt(String(opts.historyLimit ?? "200"), 10);
			await runTui({
				url: opts.url,
				token: opts.token,
				password: opts.password,
				session: opts.session,
				deliver: Boolean(opts.deliver),
				thinking: opts.thinking,
				message: opts.message,
				timeoutMs,
				historyLimit: Number.isNaN(historyLimit) ? void 0 : historyLimit
			});
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
}

//#endregion
export { registerTuiCli };