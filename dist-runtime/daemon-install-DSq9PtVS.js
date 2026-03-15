import "./redact-CPjO5IzK.js";
import "./errors-CHvVoeNX.js";
import "./unhandled-rejections-BUxLQs1F.js";
import "./globals-I5DlBD2D.js";
import "./paths-1qR_mW4i.js";
import "./theme-UkqnBJaj.js";
import "./subsystem-EnljYYs1.js";
import "./ansi-YpD2Ho3J.js";
import "./boolean-B938tROv.js";
import "./env-Bdj-riuG.js";
import "./warning-filter-xAwZkSAQ.js";
import "./utils-Do8MzKyM.js";
import "./links-Cx-Xmp-Y.js";
import "./auth-profiles-DqxBs6Au.js";
import "./plugins-allowlist-CTOQWcBK.js";
import "./registry-DrRO3PZ7.js";
import "./fetch-DM2X1MUS.js";
import "./config-state-Dtu4rsXl.js";
import "./filter-Qe6Ch68_.js";
import "./manifest-registry-CA0yK887.js";
import "./method-scopes-DDb5C1xl.js";
import "./plugins-CygWjihb.js";
import "./brew-BBTHZkpM.js";
import "./agent-scope-tkfLX5MZ.js";
import "./logger-BwHrL168.js";
import "./exec-Fh3CK0qE.js";
import "./env-overrides-ArVaLl04.js";
import "./safe-text-ByhWP-8W.js";
import "./version-Dubp0iGu.js";
import "./config-VO8zzMSR.js";
import "./workspace-dirs-D1oDbsnN.js";
import "./search-manager-DIDe1qlM.js";
import "./ip-Cdtea-sx.js";
import "./device-metadata-normalization-a2oQYp64.js";
import "./query-expansion-CcKf_qr0.js";
import "./command-secret-targets-7sQA1Mwd.js";
import "./frontmatter-UI6LO8NQ.js";
import "./path-alias-guards-SF-nwQor.js";
import "./skills-eb8njEg8.js";
import "./commands-BRfqrztE.js";
import "./ports-DeHp-MTZ.js";
import "./ports-lsof-CCbcofNf.js";
import "./ssh-tunnel-Cu8erp19.js";
import "./mime-h80iV1FL.js";
import "./delivery-queue-CfAp_q6e.js";
import "./paths-YN5WLIkL.js";
import "./session-cost-usage-DeAwWk6A.js";
import "./fetch-CzYOE42F.js";
import "./identity-file-Dh-pAEVE.js";
import "./dm-policy-shared-qfNerugD.js";
import "./multimodal-IUqnzBU8.js";
import "./memory-search-BI0f8wZY.js";
import "./prompt-style-DqOsOwLH.js";
import "./secret-file-Bd-d3WTG.js";
import "./token-C5m9DX_R.js";
import "./restart-stale-pids-DzpGvXwg.js";
import "./accounts-B1y-wv7m.js";
import "./audit-CmcUcZU1.js";
import "./cli-utils-DRykF2zj.js";
import "./daemon-install-plan.shared-B7RGrAF1.js";
import "./runtime-paths-cQOj5Aup.js";
import "./runtime-guard-BGgJKfMx.js";
import { n as buildGatewayInstallPlan, r as gatewayInstallErrorHint, t as resolveGatewayInstallToken } from "./gateway-install-token-BqkLsen1.js";
import { r as isGatewayDaemonRuntime } from "./daemon-runtime-Tgt-ZRti.js";
import "./runtime-parse-DQXHHtms.js";
import "./launchd-BbDrm470.js";
import { n as resolveGatewayService } from "./service-DC_Pq39i.js";
import { i as isSystemdUserServiceAvailable } from "./systemd-Bb__IPfT.js";
import "./note-DjpUEsPR.js";
import { n as ensureSystemdUserLingerNonInteractive } from "./systemd-linger-D-fK-3vX.js";
//#region src/commands/onboard-non-interactive/local/daemon-install.ts
async function installGatewayDaemonNonInteractive(params) {
	const { opts, runtime, port } = params;
	if (!opts.installDaemon) {return { installed: false };}
	const daemonRuntimeRaw = opts.daemonRuntime ?? "node";
	const systemdAvailable = process.platform === "linux" ? await isSystemdUserServiceAvailable() : true;
	if (process.platform === "linux" && !systemdAvailable) {
		runtime.log("Systemd user services are unavailable; skipping service install. Use a direct shell run (`openclaw gateway run`) or rerun without --install-daemon on this session.");
		return {
			installed: false,
			skippedReason: "systemd-user-unavailable"
		};
	}
	if (!isGatewayDaemonRuntime(daemonRuntimeRaw)) {
		runtime.error("Invalid --daemon-runtime (use node or bun)");
		runtime.exit(1);
		return { installed: false };
	}
	const service = resolveGatewayService();
	const tokenResolution = await resolveGatewayInstallToken({
		config: params.nextConfig,
		env: process.env
	});
	for (const warning of tokenResolution.warnings) {runtime.log(warning);}
	if (tokenResolution.unavailableReason) {
		runtime.error([
			"Gateway install blocked:",
			tokenResolution.unavailableReason,
			"Fix gateway auth config/token input and rerun setup."
		].join(" "));
		runtime.exit(1);
		return { installed: false };
	}
	const { programArguments, workingDirectory, environment } = await buildGatewayInstallPlan({
		env: process.env,
		port,
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
		return { installed: false };
	}
	await ensureSystemdUserLingerNonInteractive({ runtime });
	return { installed: true };
}
//#endregion
export { installGatewayDaemonNonInteractive };
