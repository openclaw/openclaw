import { t as formatDocsLink } from "./links-CM5vg8_V.js";
import { r as theme } from "./theme-D58JpUfy.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as parseTimeoutMs } from "./parse-timeout-91AFhn8L.js";
//#region src/cli/tui-cli.ts
function registerTuiCli(program) {
	program.command("tui").alias("terminal").alias("chat").description("Open a terminal UI connected to the Gateway").option("--local", "Run against the local embedded agent runtime", false).option("--url <url>", "Gateway WebSocket URL (defaults to gateway.remote.url when configured)").option("--token <token>", "Gateway token (if required)").option("--password <password>", "Gateway password (if required)").option("--session <key>", "Session key (default: \"main\", or \"global\" when scope is global)").option("--deliver", "Deliver assistant replies", false).option("--thinking <level>", "Thinking level override").option("--message <text>", "Send an initial message after connecting").option("--timeout-ms <ms>", "Agent timeout in ms (defaults to agents.defaults.timeoutSeconds)").option("--history-limit <n>", "History entries to load", "200").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/tui", "docs.openclaw.ai/cli/tui")}\n`).action(async (opts, cmd) => {
		try {
			const invokedSubcommand = cmd.parent?.args[0];
			const invokedAsLocalAlias = invokedSubcommand === "terminal" || invokedSubcommand === "chat";
			const isLocal = Boolean(opts.local) || invokedAsLocalAlias;
			if (isLocal && (opts.url || opts.token || opts.password)) throw new Error("--local cannot be combined with --url, --token, or --password");
			const timeoutMs = parseTimeoutMs(opts.timeoutMs);
			if (opts.timeoutMs !== void 0 && timeoutMs === void 0) defaultRuntime.error(`warning: invalid --timeout-ms "${String(opts.timeoutMs)}"; ignoring`);
			const historyLimit = Number.parseInt(String(opts.historyLimit ?? "200"), 10);
			const { runTui } = await import("./tui-BDW2N68q.js");
			await runTui({
				local: isLocal,
				url: opts.url,
				token: opts.token,
				password: opts.password,
				session: opts.session,
				deliver: Boolean(opts.deliver),
				thinking: opts.thinking,
				message: opts.message,
				timeoutMs,
				historyLimit: Number.isNaN(historyLimit) ? void 0 : historyLimit,
				forceProcessExitOnReturn: true
			});
		} catch (err) {
			defaultRuntime.error(String(err));
			defaultRuntime.exit(1);
		}
	});
}
//#endregion
export { registerTuiCli };
