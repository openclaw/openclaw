import { f as resolveIsNixMode, i as init_paths } from "./paths-DqbqmTPe.js";
import { d as defaultRuntime, f as init_runtime } from "./subsystem-CZwunM2N.js";
import { Hb as readBestEffortConfig, Ub as readConfigFileSnapshot } from "./auth-profiles-DAOR1fRn.js";
import { g as isGatewaySecretRefUnavailableError, v as resolveGatewayDriftCheckCredentialsFromConfig } from "./config-DZ3oWznn.js";
import { i as isWSL } from "./fetch-wLdC1F30.js";
import { t as describeGatewayServiceRestart } from "./service-BRvD766e.js";
import { i as isSystemdUserServiceAvailable } from "./systemd-Ca2xqSN-.js";
import { f as buildDaemonServiceSnapshot, m as emitDaemonActionJson, p as createNullWriter } from "./shared-CCPEqzJi.js";
import { a as checkTokenDrift, n as renderSystemdUnavailableHints } from "./systemd-hints-CyeYGmDG.js";
import { n as formatConfigIssueLines } from "./issue-format-CBjhFckx.js";
//#region src/cli/daemon-cli/gateway-token-drift.ts
function resolveGatewayTokenForDriftCheck(params) {
	params.env;
	return resolveGatewayDriftCheckCredentialsFromConfig({ cfg: params.cfg }).token;
}
//#endregion
//#region src/cli/daemon-cli/lifecycle-core.ts
init_paths();
init_runtime();
async function maybeAugmentSystemdHints(hints) {
	if (process.platform !== "linux") return hints;
	if (await isSystemdUserServiceAvailable().catch(() => false)) return hints;
	return [...hints, ...renderSystemdUnavailableHints({ wsl: await isWSL() })];
}
function createActionIO(params) {
	const stdout = params.json ? createNullWriter() : process.stdout;
	const emit = (payload) => {
		if (!params.json) return;
		emitDaemonActionJson({
			action: params.action,
			...payload
		});
	};
	const fail = (message, hints) => {
		if (params.json) emit({
			ok: false,
			error: message,
			hints
		});
		else defaultRuntime.error(message);
		defaultRuntime.exit(1);
	};
	return {
		stdout,
		emit,
		fail
	};
}
async function handleServiceNotLoaded(params) {
	const hints = await maybeAugmentSystemdHints(params.renderStartHints());
	params.emit({
		ok: true,
		result: "not-loaded",
		message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
		hints,
		service: buildDaemonServiceSnapshot(params.service, params.loaded)
	});
	if (!params.json) {
		defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
		for (const hint of hints) defaultRuntime.log(`Start with: ${hint}`);
	}
}
async function resolveServiceLoadedOrFail(params) {
	try {
		return await params.service.isLoaded({ env: process.env });
	} catch (err) {
		params.fail(`${params.serviceNoun} service check failed: ${String(err)}`);
		return null;
	}
}
/**
* Best-effort config validation. Returns a string describing the issues if
* config exists and is invalid, or null if config is valid/missing/unreadable.
*
* Note: This reads the config file snapshot in the current CLI environment.
* Configs using env vars only available in the service context (launchd/systemd)
* may produce false positives, but the check is intentionally best-effort —
* a false positive here is safer than a crash on startup. (#35862)
*/
async function getConfigValidationError() {
	try {
		const snapshot = await readConfigFileSnapshot();
		if (!snapshot.exists || snapshot.valid) return null;
		return snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n") : "Unknown validation issue.";
	} catch {
		return null;
	}
}
async function runServiceUninstall(params) {
	const { stdout, emit, fail } = createActionIO({
		action: "uninstall",
		json: Boolean(params.opts?.json)
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service uninstall is disabled.");
		return;
	}
	let loaded = false;
	try {
		loaded = await params.service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (loaded && params.stopBeforeUninstall) try {
		await params.service.stop({
			env: process.env,
			stdout
		});
	} catch {}
	try {
		await params.service.uninstall({
			env: process.env,
			stdout
		});
	} catch (err) {
		fail(`${params.serviceNoun} uninstall failed: ${String(err)}`);
		return;
	}
	loaded = false;
	try {
		loaded = await params.service.isLoaded({ env: process.env });
	} catch {
		loaded = false;
	}
	if (loaded && params.assertNotLoadedAfterUninstall) {
		fail(`${params.serviceNoun} service still loaded after uninstall.`);
		return;
	}
	emit({
		ok: true,
		result: "uninstalled",
		service: buildDaemonServiceSnapshot(params.service, loaded)
	});
}
async function runServiceStart(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "start",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	if (!loaded) {
		await handleServiceNotLoaded({
			serviceNoun: params.serviceNoun,
			service: params.service,
			loaded,
			renderStartHints: params.renderStartHints,
			json,
			emit
		});
		return;
	}
	{
		const configError = await getConfigValidationError();
		if (configError) {
			fail(`${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`);
			return;
		}
	}
	try {
		const restartResult = await params.service.restart({
			env: process.env,
			stdout
		});
		const restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) {
			emit({
				ok: true,
				result: restartStatus.daemonActionResult,
				message: restartStatus.message,
				service: buildDaemonServiceSnapshot(params.service, loaded)
			});
			if (!json) defaultRuntime.log(restartStatus.message);
			return;
		}
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
		return;
	}
	let started = true;
	try {
		started = await params.service.isLoaded({ env: process.env });
	} catch {
		started = true;
	}
	emit({
		ok: true,
		result: "started",
		service: buildDaemonServiceSnapshot(params.service, started)
	});
}
async function runServiceStop(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "stop",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	if (!loaded) {
		try {
			const handled = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			});
			if (handled) {
				emit({
					ok: true,
					result: handled.result,
					message: handled.message,
					warnings: handled.warnings,
					service: buildDaemonServiceSnapshot(params.service, false)
				});
				if (!json && handled.message) defaultRuntime.log(handled.message);
				return;
			}
		} catch (err) {
			fail(`${params.serviceNoun} stop failed: ${String(err)}`);
			return;
		}
		emit({
			ok: true,
			result: "not-loaded",
			message: `${params.serviceNoun} service ${params.service.notLoadedText}.`,
			service: buildDaemonServiceSnapshot(params.service, loaded)
		});
		if (!json) defaultRuntime.log(`${params.serviceNoun} service ${params.service.notLoadedText}.`);
		return;
	}
	try {
		await params.service.stop({
			env: process.env,
			stdout
		});
	} catch (err) {
		fail(`${params.serviceNoun} stop failed: ${String(err)}`);
		return;
	}
	let stopped = false;
	try {
		stopped = await params.service.isLoaded({ env: process.env });
	} catch {
		stopped = false;
	}
	emit({
		ok: true,
		result: "stopped",
		service: buildDaemonServiceSnapshot(params.service, stopped)
	});
}
async function runServiceRestart(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createActionIO({
		action: "restart",
		json
	});
	const warnings = [];
	let handledNotLoaded = null;
	const emitScheduledRestart = (restartStatus, serviceLoaded) => {
		emit({
			ok: true,
			result: restartStatus.daemonActionResult,
			message: restartStatus.message,
			service: buildDaemonServiceSnapshot(params.service, serviceLoaded),
			warnings: warnings.length ? warnings : void 0
		});
		if (!json) defaultRuntime.log(restartStatus.message);
		return true;
	};
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return false;
	{
		const configError = await getConfigValidationError();
		if (configError) {
			fail(`${params.serviceNoun} aborted: config is invalid.\n${configError}\nFix the config and retry, or run "openclaw doctor" to repair.`);
			return false;
		}
	}
	if (!loaded) {
		try {
			handledNotLoaded = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			}) ?? null;
		} catch (err) {
			fail(`${params.serviceNoun} restart failed: ${String(err)}`);
			return false;
		}
		if (!handledNotLoaded) {
			await handleServiceNotLoaded({
				serviceNoun: params.serviceNoun,
				service: params.service,
				loaded,
				renderStartHints: params.renderStartHints,
				json,
				emit
			});
			return false;
		}
		if (handledNotLoaded.warnings?.length) warnings.push(...handledNotLoaded.warnings);
	}
	if (loaded && params.checkTokenDrift) try {
		const serviceToken = (await params.service.readCommand(process.env))?.environment?.OPENCLAW_GATEWAY_TOKEN;
		const driftIssue = checkTokenDrift({
			serviceToken,
			configToken: resolveGatewayTokenForDriftCheck({
				cfg: await readBestEffortConfig(),
				env: process.env
			})
		});
		if (driftIssue) {
			const warning = driftIssue.detail ? `${driftIssue.message} ${driftIssue.detail}` : driftIssue.message;
			warnings.push(warning);
			if (!json) {
				defaultRuntime.log(`\n⚠️  ${driftIssue.message}`);
				if (driftIssue.detail) defaultRuntime.log(`   ${driftIssue.detail}\n`);
			}
		}
	} catch (err) {
		if (isGatewaySecretRefUnavailableError(err, "gateway.auth.token")) {
			const warning = "Unable to verify gateway token drift: gateway.auth.token SecretRef is configured but unavailable in this command path.";
			warnings.push(warning);
			if (!json) defaultRuntime.log(`\n⚠️  ${warning}\n`);
		}
	}
	try {
		let restartResult = { outcome: "completed" };
		if (loaded) restartResult = await params.service.restart({
			env: process.env,
			stdout
		});
		let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) return emitScheduledRestart(restartStatus, loaded);
		if (params.postRestartCheck) {
			const postRestartResult = await params.postRestartCheck({
				json,
				stdout,
				warnings,
				fail
			});
			if (postRestartResult) {
				restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
				if (restartStatus.scheduled) return emitScheduledRestart(restartStatus, loaded);
			}
		}
		let restarted = loaded;
		if (loaded) try {
			restarted = await params.service.isLoaded({ env: process.env });
		} catch {
			restarted = true;
		}
		emit({
			ok: true,
			result: "restarted",
			message: handledNotLoaded?.message,
			service: buildDaemonServiceSnapshot(params.service, restarted),
			warnings: warnings.length ? warnings : void 0
		});
		if (!json && handledNotLoaded?.message) defaultRuntime.log(handledNotLoaded.message);
		return true;
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
		return false;
	}
}
//#endregion
export { runServiceUninstall as i, runServiceStart as n, runServiceStop as r, runServiceRestart as t };
