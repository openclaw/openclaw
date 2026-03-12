import "./paths-B4BZAPZh.js";
import "./utils-BKDT474X.js";
import "./subsystem-LTWJBEIv.js";
import "./exec-NrPPwdAe.js";
import "./host-env-security-lcjXF83D.js";
import "./env-vars-Duxu9t5m.js";
import "./prompt-style-CQUEv9Gp.js";
import "./runtime-guard-C-Xp_TV0.js";
import "./note-DcEdE35k.js";
import { n as gatewayInstallErrorHint, t as buildGatewayInstallPlan } from "./daemon-install-helpers-BbXZcxdV.js";
import { r as isGatewayDaemonRuntime, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-uqrdhRz3.js";
import { r as isSystemdUserServiceAvailable } from "./systemd-C5rdv1uf.js";
import { t as resolveGatewayService } from "./service-gv1-6Hix.js";
import { n as ensureSystemdUserLingerNonInteractive } from "./systemd-linger-Ds4SKWoz.js";

//#region src/commands/onboard-non-interactive/local/daemon-install.ts
async function installGatewayDaemonNonInteractive(params) {
	const { opts, runtime, port, gatewayToken } = params;
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
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
		token: gatewayToken,
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