import "./paths-BBP4yd-2.js";
import "./globals-DBA9iEt5.js";
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
import "./dock-D67Q8hqq.js";
import "./message-channel-BTTrmWeS.js";
import "./plugins-CVNXMV8f.js";
import "./sessions-oRavjpc9.js";
import "./tailscale-CuFyx_x9.js";
import "./tailnet-BlWYu4Vr.js";
import "./ws-OMv8Zfui.js";
import "./auth-CwHPKzRu.js";
import "./accounts-DXxZARtQ.js";
import "./accounts-Z1bz-0gv.js";
import "./logging-CZCkEw2g.js";
import "./accounts-RlQcOaUI.js";
import "./paths-J0EFKbLQ.js";
import "./chat-envelope-BZKQmhVe.js";
import "./client-0WVSaq6Z.js";
import "./call-Cc2tK_jb.js";
import "./pairing-token-B9SSCi9X.js";
import "./onboard-helpers-wSGCHqx6.js";
import "./prompt-style-D84-8NYI.js";
import "./runtime-guard-DSqWzr-M.js";
import "./note-DLdhXOw1.js";
import { n as gatewayInstallErrorHint, t as buildGatewayInstallPlan } from "./daemon-install-helpers-BClZ3Cuf.js";
import { r as isGatewayDaemonRuntime, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-VfkpXuRu.js";
import { t as resolveGatewayInstallToken } from "./gateway-install-token-ENSGLr4n.js";
import { r as isSystemdUserServiceAvailable } from "./systemd-XpOThQj6.js";
import { t as resolveGatewayService } from "./service-B-DRw2aO.js";
import { n as ensureSystemdUserLingerNonInteractive } from "./systemd-linger-CVMk9u49.js";

//#region src/commands/onboard-non-interactive/local/daemon-install.ts
async function installGatewayDaemonNonInteractive(params) {
	const { opts, runtime, port } = params;
	if (!opts.installDaemon) return;
	const daemonRuntimeRaw = opts.daemonRuntime ?? DEFAULT_GATEWAY_DAEMON_RUNTIME;
	const systemdAvailable = process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
	if (process.platform === "linux" && !systemdAvailable) {
		runtime.log("Systemd user services are unavailable; skipping service install.");
		return;
	}
	if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
		runtime.error("Invalid --daemon-runtime (use node or bun)");
		runtime.exit(1);
		return;
	}
	const service = resolveGatewayService();
	const tokenResolution = await resolveGatewayInstallToken({
		config: params.nextConfig,
		env: process.env
	});
	for (const warning of tokenResolution.warnings) runtime.log(warning);
	if (tokenResolution.unavailableReason) {
		runtime.error([
			"Gateway install blocked:",
			tokenResolution.unavailableReason,
			"Fix gateway auth config/token input and rerun onboarding."
		].join(" "));
		runtime.exit(1);
		return;
	}
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
		token: tokenResolution.token,
		runtime: daemonRuntimeRaw,
		warn: (message) => runtime.log(message),
		config: params.nextConfig
	});
	try {
		await service.install({
			env: process.env,
			stdout: process.stdout,
			programArguments,
			workingDirectory,
			environment
		});
	} catch (err) {
		runtime.error(`Gateway service install failed: ${String(err)}`);
		runtime.log(gatewayInstallErrorHint());
		return;
	}
	await ensureSystemdUserLingerNonInteractive({ runtime });
}

//#endregion
export { installGatewayDaemonNonInteractive };