import { h as theme, t as danger } from "./globals-DqM7Q4km.js";
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
import "./message-channel-Uz3-Q9E0.js";
import "./client-B-hNLzzd.js";
import "./call-Bwq3qM8o.js";
import "./pairing-token-BXrId5bQ.js";
import "./net-DAPyFre2.js";
import "./tailnet-D3NBwZ0q.js";
import { t as formatDocsLink } from "./links-dO-svE2W.js";
import "./progress-CAPOQFI0.js";
import { n as callGatewayFromCli, t as addGatewayClientOptions } from "./gateway-rpc-CW7CWqUf.js";

//#region src/cli/system-cli.ts
const normalizeWakeMode = (raw) => {
	const mode = typeof raw === "string" ? raw.trim() : "";
	if (!mode) return "next-heartbeat";
	if (mode === "now" || mode === "next-heartbeat") return mode;
	throw new Error("--mode must be now or next-heartbeat");
};
async function runSystemGatewayCommand(opts, action, successText) {
	try {
		const result = await action();
		if (opts.json || successText === void 0) defaultRuntime.log(JSON.stringify(result, null, 2));
		else defaultRuntime.log(successText);
	} catch (err) {
		defaultRuntime.error(danger(String(err)));
		defaultRuntime.exit(1);
	}
}
function registerSystemCli(program) {
	const system = program.command("system").description("System tools (events, heartbeat, presence)").addHelpText("after", () => `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/system", "docs.openclaw.ai/cli/system")}\n`);
	addGatewayClientOptions(system.command("event").description("Enqueue a system event and optionally trigger a heartbeat").requiredOption("--text <text>", "System event text").option("--mode <mode>", "Wake mode (now|next-heartbeat)", "next-heartbeat").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			const text = typeof opts.text === "string" ? opts.text.trim() : "";
			if (!text) throw new Error("--text is required");
			return await callGatewayFromCli("wake", opts, {
				mode: normalizeWakeMode(opts.mode),
				text
			}, { expectFinal: false });
		}, "ok");
	});
	const heartbeat = system.command("heartbeat").description("Heartbeat controls");
	addGatewayClientOptions(heartbeat.command("last").description("Show the last heartbeat event").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("last-heartbeat", opts, void 0, { expectFinal: false });
		});
	});
	addGatewayClientOptions(heartbeat.command("enable").description("Enable heartbeats").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("set-heartbeats", opts, { enabled: true }, { expectFinal: false });
		});
	});
	addGatewayClientOptions(heartbeat.command("disable").description("Disable heartbeats").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("set-heartbeats", opts, { enabled: false }, { expectFinal: false });
		});
	});
	addGatewayClientOptions(system.command("presence").description("List system presence entries").option("--json", "Output JSON", false)).action(async (opts) => {
		await runSystemGatewayCommand(opts, async () => {
			return await callGatewayFromCli("system-presence", opts, void 0, { expectFinal: false });
		});
	});
}

//#endregion
export { registerSystemCli };