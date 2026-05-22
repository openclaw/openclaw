import { t as createSubsystemLogger } from "./subsystem-D1_uRCZT.js";
import { r as runCommandWithTimeout } from "./exec-Dxmq14-v.js";
import { n as hasBinary } from "./config-eval-BtLE4Xbn.js";
import "./skills-BHYsqYYy.js";
import { T as resolveGmailHookRuntimeConfig, _ as buildGogWatchServeLogArgs, g as buildGogWatchServeArgs, i as ensureTailscaleEndpoint, v as buildGogWatchStartArgs } from "./gmail-setup-utils-DXDGGmVg.js";
import { spawn } from "node:child_process";
//#region src/hooks/gmail-watcher-errors.ts
const ADDRESS_IN_USE_RE = /address already in use|EADDRINUSE/i;
function isAddressInUseError(line) {
	return ADDRESS_IN_USE_RE.test(line);
}
//#endregion
//#region src/hooks/gmail-watcher.ts
/**
* Gmail Watcher Service
*
* Automatically starts `gog gmail watch serve` when the gateway starts,
* if hooks.gmail is configured with an account.
*/
const log = createSubsystemLogger("gmail-watcher");
let watcherProcess = null;
let renewInterval = null;
let shuttingDown = false;
let currentConfig = null;
/**
* Check if gog binary is available
*/
function isGogAvailable() {
	return hasBinary("gog");
}
/**
* Start the Gmail watch (registers with Gmail API)
*/
async function startGmailWatch(cfg) {
	const args = ["gog", ...buildGogWatchStartArgs(cfg)];
	try {
		const result = await runCommandWithTimeout(args, { timeoutMs: 12e4 });
		if (result.code !== 0) {
			const message = result.stderr || result.stdout || "gog watch start failed";
			log.error(`watch start failed: ${message}`);
			return false;
		}
		log.info(`watch started for ${cfg.account}`);
		return true;
	} catch (err) {
		log.error(`watch start error: ${String(err)}`);
		return false;
	}
}
/**
* Spawn the gog gmail watch serve process
*/
function spawnGogServe(cfg) {
	const args = buildGogWatchServeArgs(cfg);
	log.info(`starting gog ${buildGogWatchServeLogArgs(cfg).join(" ")}`);
	let addressInUse = false;
	const child = spawn("gog", args, {
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		detached: false
	});
	child.stdout?.on("data", (data) => {
		const line = data.toString().trim();
		if (line) log.info(`[gog] ${line}`);
	});
	child.stderr?.on("data", (data) => {
		const line = data.toString().trim();
		if (!line) return;
		if (isAddressInUseError(line)) addressInUse = true;
		log.warn(`[gog] ${line}`);
	});
	child.on("error", (err) => {
		log.error(`gog process error: ${String(err)}`);
	});
	child.on("exit", (code, signal) => {
		if (shuttingDown) return;
		if (addressInUse) {
			log.warn("gog serve failed to bind (address already in use); stopping restarts. Another watcher is likely running. Set OPENCLAW_SKIP_GMAIL_WATCHER=1 or stop the other process.");
			watcherProcess = null;
			return;
		}
		log.warn(`gog exited (code=${code}, signal=${signal}); restarting in 5s`);
		watcherProcess = null;
		setTimeout(() => {
			if (shuttingDown || !currentConfig) return;
			watcherProcess = spawnGogServe(currentConfig);
		}, 5e3);
	});
	return child;
}
/**
* Start the Gmail watcher service.
* Called automatically by the gateway if hooks.gmail is configured.
*/
async function startGmailWatcher(cfg) {
	if (!cfg.hooks?.enabled) return {
		started: false,
		reason: "hooks not enabled"
	};
	if (!cfg.hooks?.gmail?.account) return {
		started: false,
		reason: "no gmail account configured"
	};
	if (!isGogAvailable()) return {
		started: false,
		reason: "gog binary not found"
	};
	const resolved = resolveGmailHookRuntimeConfig(cfg, {});
	if (!resolved.ok) return {
		started: false,
		reason: resolved.error
	};
	const runtimeConfig = resolved.value;
	currentConfig = runtimeConfig;
	if (runtimeConfig.tailscale.mode !== "off") try {
		await ensureTailscaleEndpoint({
			mode: runtimeConfig.tailscale.mode,
			path: runtimeConfig.tailscale.path,
			port: runtimeConfig.serve.port,
			target: runtimeConfig.tailscale.target
		});
		log.info(`tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`);
	} catch (err) {
		log.error(`tailscale setup failed: ${String(err)}`);
		return {
			started: false,
			reason: `tailscale setup failed: ${String(err)}`
		};
	}
	if (!await startGmailWatch(runtimeConfig)) log.warn("gmail watch start failed, but continuing with serve");
	shuttingDown = false;
	watcherProcess = spawnGogServe(runtimeConfig);
	const renewMs = runtimeConfig.renewEveryMinutes * 6e4;
	renewInterval = setInterval(() => {
		if (shuttingDown) return;
		startGmailWatch(runtimeConfig);
	}, renewMs);
	log.info(`gmail watcher started for ${runtimeConfig.account} (renew every ${runtimeConfig.renewEveryMinutes}m)`);
	return { started: true };
}
/**
* Stop the Gmail watcher service.
*/
async function stopGmailWatcher() {
	shuttingDown = true;
	if (renewInterval) {
		clearInterval(renewInterval);
		renewInterval = null;
	}
	if (watcherProcess) {
		log.info("stopping gmail watcher");
		watcherProcess.kill("SIGTERM");
		await new Promise((resolve) => {
			const timeout = setTimeout(() => {
				if (watcherProcess) watcherProcess.kill("SIGKILL");
				resolve();
			}, 3e3);
			watcherProcess?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});
		watcherProcess = null;
	}
	currentConfig = null;
	log.info("gmail watcher stopped");
}
//#endregion
export { stopGmailWatcher as n, startGmailWatcher as t };
