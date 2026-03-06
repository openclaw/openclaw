import { h as theme } from "./globals-DqM7Q4km.js";
import "./paths-BMo6kTge.js";
import { d as defaultRuntime } from "./subsystem-BXiL6bA6.js";
import "./boolean-DtWR5bt3.js";
import "./auth-profiles-C39jSzPb.js";
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
import "./dock-CK-Sk5ak.js";
import "./frontmatter-D2o8_Jfu.js";
import "./skills-LzLwUYxz.js";
import "./path-alias-guards--u7-iWd6.js";
import "./message-channel-Uz3-Q9E0.js";
import "./sessions-Bx1XJLag.js";
import "./plugins-D8yPNTgi.js";
import "./accounts-C8pI_u-9.js";
import "./accounts-Cg8cGZPE.js";
import "./logging-CcxUDNcI.js";
import "./accounts-DBl2tRX-.js";
import "./paths-DAWfoG1N.js";
import "./chat-envelope-D3RSz140.js";
import "./client-B-hNLzzd.js";
import "./call-Bwq3qM8o.js";
import "./pairing-token-BXrId5bQ.js";
import "./net-DAPyFre2.js";
import "./tailnet-D3NBwZ0q.js";
import "./image-ops-Col_4Cje.js";
import "./pi-embedded-helpers-UK-0PB7S.js";
import "./sandbox-CncbttKI.js";
import "./tool-catalog-C04U7H3F.js";
import "./chrome-Doer_-zM.js";
import "./tailscale-djvfM56G.js";
import "./auth-BF7ZEz6Z.js";
import "./server-context-CfF4HsIY.js";
import "./paths-CSIzn_T3.js";
import "./redact-LEFt15z2.js";
import "./errors-8nIQWcYq.js";
import "./fs-safe-DS4hJvDc.js";
import "./proxy-env-BaaBkV0s.js";
import "./store--dkmRyD9.js";
import "./ports-fzkwfwGz.js";
import "./trash-G16GLJQp.js";
import "./server-middleware-84TSGaQH.js";
import "./tool-images-Dpg-bSxD.js";
import "./thinking-btBo_vAx.js";
import "./tool-display-DriahLIA.js";
import "./commands-BZwK_e0W.js";
import "./commands-registry-gur48hks.js";
import { t as parseTimeoutMs } from "./parse-timeout-CuYdP9TL.js";
import { t as formatDocsLink } from "./links-dO-svE2W.js";
import "./resolve-configured-secret-input-string-B3e1161V.js";
import { t as runTui } from "./tui-Ca1yETmy.js";

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