import { p as resolveIsNixMode } from "./paths-Cw7f9XhU.js";
import { t as formatCliCommand } from "./command-format-BPjMauol.js";
import { a as isSystemdUserServiceAvailable } from "./systemd-DsQkjgIm.js";
import { n as defaultRuntime } from "./runtime-yzlkhCoS.js";
import { t as createGatewayCredentialPlan } from "./credential-planner-DPeD90hR.js";
import { n as isGatewaySecretRefUnavailableError, t as GatewaySecretRefUnavailableError } from "./credentials-BJ7jvgw3.js";
import { t as resolveGatewayAuthToken } from "./auth-token-resolution-BXDTKdSY.js";
import { l as readBestEffortConfig, u as readConfigFileSnapshot } from "./io-DoswVvYe.js";
import { n as formatConfigIssueLines } from "./issue-format-c8ezaSew.js";
import { r as resolveFutureConfigActionBlock } from "./future-version-guard-B-IQpuuA.js";
import { r as checkTokenDrift } from "./service-audit-DwiTvjdX.js";
import "./config-B6Oplu5W.js";
import { a as startGatewayService, t as describeGatewayServiceRestart } from "./service-CTzdMGsq.js";
import { o as renderSystemdUnavailableHints } from "./runtime-hints-BcO9gSNA.js";
import { t as isWSL } from "./wsl-2-jVkfxN.js";
import { i as filterContainerGenericHints, m as createDaemonActionContext, p as buildDaemonServiceSnapshot } from "./shared-X3VACeu2.js";
import { g as writeGatewayRestartIntentSync, t as clearGatewayRestartIntentSync } from "./restart-C-r_0sSG.js";
import { t as formatInvalidConfigRecoveryHint } from "./config-recovery-hints-CYJi2Hra.js";
//#region src/cli/daemon-cli/gateway-token-drift.ts
function authModeDisablesToken(mode) {
	return mode === "password" || mode === "none" || mode === "trusted-proxy";
}
function isPasswordFallbackActive(params) {
	const plan = createGatewayCredentialPlan({
		config: params.cfg,
		env: params.env
	});
	if (plan.authMode !== void 0) return false;
	return plan.passwordCanWin && !plan.tokenCanWin;
}
async function resolveGatewayTokenForDriftCheck(params) {
	const env = params.env ?? process.env;
	const mode = params.cfg.gateway?.auth?.mode;
	if (authModeDisablesToken(mode)) return;
	if (isPasswordFallbackActive({
		cfg: params.cfg,
		env
	})) return;
	const resolved = await resolveGatewayAuthToken({
		cfg: params.cfg,
		env,
		envFallback: "never",
		unresolvedReasonStyle: "detailed"
	});
	if (resolved.token) return resolved.token;
	if (!resolved.secretRefConfigured) return;
	throw new GatewaySecretRefUnavailableError("gateway.auth.token");
}
//#endregion
//#region src/cli/daemon-cli/lifecycle-core.ts
async function maybeAugmentSystemdHints(hints) {
	if (process.platform !== "linux") return hints;
	if (await isSystemdUserServiceAvailable().catch(() => false)) return hints;
	return [...hints, ...renderSystemdUnavailableHints({
		wsl: await isWSL(),
		kind: "generic_unavailable"
	})];
}
function emitActionMessage(params) {
	params.emit(params.payload);
	if (!params.json && params.payload.message) defaultRuntime.log(params.payload.message);
}
async function handleServiceNotLoaded(params) {
	const hints = filterContainerGenericHints(await maybeAugmentSystemdHints(params.renderStartHints()));
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
async function getConfigActionPreflightFailure(action) {
	let snapshot;
	try {
		snapshot = await readConfigFileSnapshot();
		if (snapshot.exists && !snapshot.valid) return { message: snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n") : "Unknown validation issue." };
	} catch {
		return null;
	}
	const futureBlock = resolveFutureConfigActionBlock({
		action,
		snapshot
	});
	if (futureBlock) return {
		message: futureBlock.message,
		hints: futureBlock.hints
	};
	return null;
}
async function runServiceUninstall(params) {
	const { stdout, emit, fail } = createDaemonActionContext({
		action: "uninstall",
		json: Boolean(params.opts?.json)
	});
	if (resolveIsNixMode(process.env)) {
		fail("Nix mode detected; service uninstall is disabled.");
		return;
	}
	{
		const preflight = await getConfigActionPreflightFailure("uninstall the gateway service");
		if (preflight) {
			fail(`${params.serviceNoun} uninstall blocked: ${preflight.message}`, preflight.hints);
			return;
		}
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
	const { stdout, emit, fail } = createDaemonActionContext({
		action: "start",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	{
		const preflight = await getConfigActionPreflightFailure("start the gateway service");
		if (preflight) {
			fail(preflight.hints ? `${params.serviceNoun} start blocked: ${preflight.message}` : `${params.serviceNoun} aborted: config is invalid.\n${preflight.message}\n${formatInvalidConfigRecoveryHint()}`, preflight.hints);
			return;
		}
	}
	if (!loaded) try {
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
				service: buildDaemonServiceSnapshot(params.service, handled.loaded ?? false)
			});
			if (!json && handled.message) defaultRuntime.log(handled.message);
			return;
		}
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
		return;
	}
	try {
		const startResult = await startGatewayService(params.service, {
			env: process.env,
			stdout
		});
		if (startResult.outcome === "missing-install") {
			await handleServiceNotLoaded({
				serviceNoun: params.serviceNoun,
				service: params.service,
				loaded: startResult.state.loaded,
				renderStartHints: params.renderStartHints,
				json,
				emit
			});
			return;
		}
		if (startResult.outcome === "scheduled") {
			emitActionMessage({
				json,
				emit,
				payload: {
					ok: true,
					result: "scheduled",
					message: describeGatewayServiceRestart(params.serviceNoun, { outcome: "scheduled" }).message,
					service: buildDaemonServiceSnapshot(params.service, startResult.state.loaded)
				}
			});
			return;
		}
		if (startResult.outcome === "repair-required") {
			try {
				const handled = await params.repairLoadedService?.({
					json,
					stdout,
					fail,
					state: startResult.state,
					issues: startResult.issues
				});
				if (handled) {
					emit({
						ok: true,
						result: handled.result,
						message: handled.message,
						warnings: handled.warnings,
						service: buildDaemonServiceSnapshot(params.service, handled.loaded ?? true)
					});
					if (!json && handled.message) defaultRuntime.log(handled.message);
					return;
				}
			} catch (err) {
				const hints = params.renderStartHints();
				fail(`${params.serviceNoun} repair failed: ${String(err)}`, hints);
				return;
			}
			fail(`${params.serviceNoun} service needs repair before it can start: ${startResult.issues.map((issue) => issue.message).join("; ")}`, [formatCliCommand("openclaw gateway install --force")]);
			return;
		}
		emit({
			ok: true,
			result: "started",
			service: buildDaemonServiceSnapshot(params.service, startResult.state.loaded)
		});
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} start failed: ${String(err)}`, hints);
		return;
	}
}
async function runServiceStop(params) {
	const json = Boolean(params.opts?.json);
	const { stdout, emit, fail } = createDaemonActionContext({
		action: "stop",
		json
	});
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return;
	{
		const preflight = await getConfigActionPreflightFailure("stop the gateway service");
		if (preflight) {
			fail(`${params.serviceNoun} stop blocked: ${preflight.message}`, preflight.hints);
			return;
		}
	}
	if (!loaded) {
		if (params.stopWhenNotLoaded) {
			try {
				await params.service.stop({
					env: process.env,
					stdout,
					disable: params.opts?.disable
				});
			} catch (err) {
				fail(`${params.serviceNoun} stop failed: ${String(err)}`);
				return;
			}
			emit({
				ok: true,
				result: "stopped",
				service: buildDaemonServiceSnapshot(params.service, false)
			});
			return;
		}
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
			stdout,
			disable: params.opts?.disable
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
	const { stdout, emit, fail } = createDaemonActionContext({
		action: "restart",
		json
	});
	const warnings = [];
	const restartIntent = params.opts?.restartIntent;
	let handledRecovery = null;
	let recoveredLoadedState = null;
	const emitScheduledRestart = (restartStatus, serviceLoaded) => {
		emitActionMessage({
			json,
			emit,
			payload: {
				ok: true,
				result: restartStatus.daemonActionResult,
				message: restartStatus.message,
				service: buildDaemonServiceSnapshot(params.service, serviceLoaded),
				warnings: warnings.length ? warnings : void 0
			}
		});
		return true;
	};
	const loaded = await resolveServiceLoadedOrFail({
		serviceNoun: params.serviceNoun,
		service: params.service,
		fail
	});
	if (loaded === null) return false;
	{
		const preflight = await getConfigActionPreflightFailure("restart the gateway service");
		if (preflight) {
			fail(preflight.hints ? `${params.serviceNoun} restart blocked: ${preflight.message}` : `${params.serviceNoun} aborted: config is invalid.\n${preflight.message}\n${formatInvalidConfigRecoveryHint()}`, preflight.hints);
			return false;
		}
	}
	if (!loaded) {
		try {
			handledRecovery = await params.onNotLoaded?.({
				json,
				stdout,
				fail
			}) ?? null;
		} catch (err) {
			fail(`${params.serviceNoun} restart failed: ${String(err)}`);
			return false;
		}
		if (!handledRecovery) {
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
		if (handledRecovery.warnings?.length) warnings.push(...handledRecovery.warnings);
		recoveredLoadedState = handledRecovery.loaded ?? null;
	}
	if (loaded && params.checkTokenDrift) try {
		const command = await params.service.readCommand(process.env);
		const serviceToken = command?.environment?.OPENCLAW_GATEWAY_TOKEN;
		const driftIssue = checkTokenDrift({
			serviceToken,
			configToken: await resolveGatewayTokenForDriftCheck({
				cfg: await readBestEffortConfig(),
				env: {
					...process.env,
					...command?.environment
				}
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
		if (loaded) {
			let wroteRestartIntent = false;
			if (params.serviceNoun === "Gateway") wroteRestartIntent = writeGatewayRestartIntentSync({
				targetPid: (await params.service.readRuntime(process.env).catch(() => null))?.pid,
				reason: "gateway.restart",
				...restartIntent ? { intent: restartIntent } : {}
			});
			try {
				restartResult = await params.service.restart({
					env: process.env,
					stdout
				});
			} catch (err) {
				if (wroteRestartIntent) clearGatewayRestartIntentSync();
				throw err;
			}
		}
		let restartStatus = describeGatewayServiceRestart(params.serviceNoun, restartResult);
		if (restartStatus.scheduled) return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
		if (params.postRestartCheck) {
			const postRestartResult = await params.postRestartCheck({
				json,
				stdout,
				warnings,
				fail
			});
			if (postRestartResult) {
				restartStatus = describeGatewayServiceRestart(params.serviceNoun, postRestartResult);
				if (restartStatus.scheduled) return emitScheduledRestart(restartStatus, loaded || recoveredLoadedState === true);
			}
		}
		let restarted = loaded;
		if (loaded) try {
			restarted = await params.service.isLoaded({ env: process.env });
		} catch {
			restarted = true;
		}
		else if (recoveredLoadedState !== null) restarted = recoveredLoadedState;
		emit({
			ok: true,
			result: "restarted",
			message: handledRecovery?.message,
			service: buildDaemonServiceSnapshot(params.service, restarted),
			warnings: warnings.length ? warnings : void 0
		});
		if (!json && handledRecovery?.message) defaultRuntime.log(handledRecovery.message);
		return true;
	} catch (err) {
		const hints = params.renderStartHints();
		fail(`${params.serviceNoun} restart failed: ${String(err)}`, hints);
		return false;
	}
}
//#endregion
export { runServiceUninstall as i, runServiceStart as n, runServiceStop as r, runServiceRestart as t };
