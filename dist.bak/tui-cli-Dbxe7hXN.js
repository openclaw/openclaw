import "./paths-B4BZAPZh.js";
import { B as theme } from "./utils-BKDT474X.js";
import "./thinking-EAliFiVK.js";
import "./agent-scope-D8K2SjR7.js";
import { f as defaultRuntime } from "./subsystem-LTWJBEIv.js";
import "./openclaw-root-PhSD0wUu.js";
import "./exec-NrPPwdAe.js";
import "./model-selection-DILdVnl8.js";
import "./github-copilot-token-nncItI8D.js";
import "./boolean-Wzu0-e0P.js";
import "./env-BqIeOdP-.js";
import "./host-env-security-lcjXF83D.js";
import "./env-vars-Duxu9t5m.js";
import "./manifest-registry-BvFf4Q1K.js";
import "./dock-C2VnAw6v.js";
import "./message-channel-C0KMGsnJ.js";
import "./pi-embedded-helpers-D_vwTcIu.js";
import "./sandbox-Dyhzzmyi.js";
import "./tool-catalog-BWgva5h1.js";
import "./chrome-b8UNhmri.js";
import "./tailscale-D9yyoJD-.js";
import "./ip-DK-vcRii.js";
import "./tailnet-kbXXH7kK.js";
import "./ws-zZ6eXqMi.js";
import "./auth-BcIsRQqi.js";
import "./server-context-Byjwv8su.js";
import "./frontmatter-C8fqIiB_.js";
import "./skills-dyOFjtQH.js";
import "./path-alias-guards-DkmbVRdv.js";
import "./paths-s0KCOZny.js";
import "./redact-B76y7XVG.js";
import "./errors-8IxbaLwV.js";
import "./fs-safe-BlxN6w_j.js";
import "./ssrf-DN6IsWAy.js";
import "./image-ops-CFCg0YOh.js";
import "./store-DLi2fq1F.js";
import "./ports-CAJdnzGD.js";
import "./trash-B8xEzWgw.js";
import "./server-middleware-BqKURFqJ.js";
import "./sessions-DUzDEcXs.js";
import "./plugins-B9xwwhdE.js";
import "./accounts-BDIC1FjT.js";
import "./accounts-Lsgq7_wm.js";
import "./accounts-DzNOa1lz.js";
import "./bindings-DXaMWXSi.js";
import "./logging-_TuF9Wz5.js";
import "./paths-B_bX6Iw-.js";
import "./chat-envelope-CZCr0x5F.js";
import "./tool-images-al3PxqY4.js";
import "./tool-display-CERZKWmU.js";
import "./commands-FkWc_DU9.js";
import "./commands-registry-DvQussPa.js";
import "./client-xAUDLDK2.js";
import "./call-BP56BqJF.js";
import "./pairing-token-BdLe8Jtz.js";
import { t as formatDocsLink } from "./links-_OmPhBsv.js";
import { t as parseTimeoutMs } from "./parse-timeout-4VifOcrr.js";
import { t as runTui } from "./tui-DmoogSS6.js";

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