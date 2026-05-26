import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { r as runCommandWithTimeout } from "./exec-D4bhAbbv.js";
import { n as hasBinary } from "./config-eval-BH8jfSqo.js";
import "./skills-JUNRkaHl.js";
import { D as resolveGogServeInvocation, E as resolveGogExecutable, T as resolveGmailHookRuntimeConfig, _ as buildGogWatchServeLogArgs, g as buildGogWatchServeArgs, i as ensureTailscaleEndpoint, v as buildGogWatchStartArgs } from "./gmail-setup-utils-CSYv0ST9.js";
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
async function startGmailWatch(cfg, options = {}) {
	const args = [resolveGogExecutable(), ...buildGogWatchStartArgs(cfg)];
	try {
		const result = await runCommandWithTimeout(args, {
			timeoutMs: 12e4,
			signal: options.signal
		});
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
	const invocation = resolveGogServeInvocation(args);
	const child = spawn(invocation.command, invocation.args, {
		stdio: [
			"ignore",
			"pipe",
			"pipe"
		],
		detached: false,
		windowsHide: invocation.windowsHide,
		windowsVerbatimArguments: invocation.windowsVerbatimArguments
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
function cancelledGmailWatcherStart(expectedConfig) {
	if (currentConfig === expectedConfig) currentConfig = null;
	return {
		started: false,
		reason: "startup cancelled"
	};
}
function isGmailWatcherStartCancelled(options) {
	return options.signal?.aborted === true || options.isCancelled?.() === true;
}
function createGmailWatcherCancellation(options) {
	if (!options.signal && !options.isCancelled) return {
		dispose: () => {},
		isCancelled: () => false
	};
	const abortController = new AbortController();
	const abort = () => {
		if (!abortController.signal.aborted) abortController.abort();
	};
	const onAbort = () => abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });
	let cancelPoll = null;
	if (options.isCancelled) {
		cancelPoll = setInterval(() => {
			if (options.isCancelled?.()) abort();
		}, 100);
		cancelPoll.unref?.();
	}
	if (isGmailWatcherStartCancelled(options)) abort();
	return {
		dispose: () => {
			if (cancelPoll) {
				clearInterval(cancelPoll);
				cancelPoll = null;
			}
			options.signal?.removeEventListener("abort", onAbort);
		},
		isCancelled: () => abortController.signal.aborted || isGmailWatcherStartCancelled(options),
		signal: abortController.signal
	};
}
/**
* Start the Gmail watcher service.
* Called automatically by the gateway if hooks.gmail is configured.
*/
async function startGmailWatcher(cfg, options = {}) {
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
	if (isGmailWatcherStartCancelled(options)) return cancelledGmailWatcherStart(runtimeConfig);
	currentConfig = runtimeConfig;
	if (runtimeConfig.tailscale.mode !== "off") {
		const cancellation = createGmailWatcherCancellation(options);
		try {
			await ensureTailscaleEndpoint({
				mode: runtimeConfig.tailscale.mode,
				path: runtimeConfig.tailscale.path,
				port: runtimeConfig.serve.port,
				signal: cancellation.signal,
				target: runtimeConfig.tailscale.target
			});
			log.info(`tailscale ${runtimeConfig.tailscale.mode} configured for port ${runtimeConfig.serve.port}`);
			if (cancellation.isCancelled()) return cancelledGmailWatcherStart(runtimeConfig);
		} catch (err) {
			if (cancellation.isCancelled()) return cancelledGmailWatcherStart(runtimeConfig);
			log.error(`tailscale setup failed: ${String(err)}`);
			return {
				started: false,
				reason: `tailscale setup failed: ${String(err)}`
			};
		} finally {
			cancellation.dispose();
		}
	}
	const cancellation = createGmailWatcherCancellation(options);
	const watchStarted = await startGmailWatch(runtimeConfig, { signal: cancellation.signal });
	cancellation.dispose();
	if (cancellation.isCancelled()) return cancelledGmailWatcherStart(runtimeConfig);
	if (!watchStarted) log.warn("gmail watch start failed, but continuing with serve");
	if (isGmailWatcherStartCancelled(options)) return cancelledGmailWatcherStart(runtimeConfig);
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
