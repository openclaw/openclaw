import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { u as resolveGatewayPort } from "./paths-Cnwfh6dH.js";
import { t as formatCliCommand } from "./command-format-OwPqnbXG.js";
import { t as resolveNodeStartupTlsEnvironment } from "./node-startup-env-Cez_rmhp.js";
import { i as normalizeEnvVarKey, n as isDangerousHostEnvOverrideVarName, r as isDangerousHostEnvVarName } from "./host-env-security-DRikErcl.js";
import { i as OPENCLAW_WRAPPER_ENV_KEY, s as resolveOpenClawWrapperPath } from "./daemon-install-plan.shared-DfEn0wKF.js";
import { n as buildGatewayInstallPlan } from "./auth-install-policy-QSWBj93K.js";
import { n as isNonFatalSystemdInstallProbeError } from "./systemd-BK-AEF9X.js";
import { n as defaultRuntime } from "./runtime-DDH_zqCr.js";
import { r as isGatewayDaemonRuntime, t as DEFAULT_GATEWAY_DAEMON_RUNTIME } from "./daemon-runtime-6GBG3wLv.js";
import { d as readConfigFileSnapshotForWrite } from "./io-5xE1dPMK.js";
import { t as resolveGatewayInstallToken } from "./gateway-install-token-BmVmPwwQ.js";
import { r as resolveFutureConfigActionBlock } from "./future-version-guard-DDwujYcS.js";
import { a as readEmbeddedGatewayToken } from "./service-audit-KLPf9LwX.js";
import { i as resolveGatewayService } from "./service-ZFeJibwt.js";
import { n as formatInvalidConfigPort, r as formatInvalidPortOption } from "./error-format-ByBZDdph.js";
import { h as installDaemonServiceAndEmit, n as createDaemonInstallActionContext, p as buildDaemonServiceSnapshot, r as failIfNixDaemonInstallMode } from "./shared-CmXmeC7j.js";
import { t as parsePort } from "./parse-port-CTD23XjJ.js";
//#region src/cli/daemon-cli/install.ts
function mergeInstallInvocationEnv(params) {
	if (!params.existingServiceEnv || Object.keys(params.existingServiceEnv).length === 0) return params.env;
	const preservedServiceEnv = {};
	for (const [rawKey, rawValue] of Object.entries(params.existingServiceEnv)) {
		const key = normalizeEnvVarKey(rawKey, { portable: true });
		if (!key) continue;
		const upper = key.toUpperCase();
		if (upper === "OPENCLAW_WRAPPER") {
			const value = rawValue.trim();
			if (value) preservedServiceEnv[OPENCLAW_WRAPPER_ENV_KEY] = value;
			continue;
		}
		if (upper === "HOME" || upper === "PATH" || upper === "TMPDIR" || upper.startsWith("OPENCLAW_")) continue;
		if (isDangerousHostEnvVarName(key) || isDangerousHostEnvOverrideVarName(key)) continue;
		const value = rawValue.trim();
		if (!value) continue;
		preservedServiceEnv[key] = value;
	}
	return {
		...preservedServiceEnv,
		...params.env
	};
}
async function runDaemonInstall(opts) {
	const { json, stdout, warnings, emit, fail } = createDaemonInstallActionContext(opts.json);
	if (failIfNixDaemonInstallMode(fail)) return;
	const { snapshot: configSnapshot, writeOptions: configWriteOptions } = await readConfigFileSnapshotForWrite();
	const futureBlock = resolveFutureConfigActionBlock({
		action: "install or rewrite the gateway service",
		snapshot: configSnapshot
	});
	if (futureBlock) {
		fail(`Gateway install blocked: ${futureBlock.message}`, futureBlock.hints);
		return;
	}
	const cfg = configSnapshot.valid ? configSnapshot.sourceConfig : configSnapshot.config;
	const portOverride = parsePort(opts.port);
	if (opts.port !== void 0 && portOverride === null) {
		fail(formatInvalidPortOption("--port"));
		return;
	}
	const port = portOverride ?? resolveGatewayPort(cfg);
	if (!Number.isFinite(port) || port <= 0 || port > 65535) {
		fail(formatInvalidConfigPort("gateway.port"));
		return;
	}
	const runtimeRaw = opts.runtime ? opts.runtime : DEFAULT_GATEWAY_DAEMON_RUNTIME;
	if (!isGatewayDaemonRuntime(runtimeRaw)) {
		fail("Invalid --runtime (use \"node\" or \"bun\")");
		return;
	}
	let wrapperPath;
	if (opts.wrapper !== void 0) try {
		wrapperPath = await resolveOpenClawWrapperPath(opts.wrapper);
		if (!wrapperPath) {
			fail("Invalid --wrapper");
			return;
		}
	} catch (err) {
		fail(`Invalid --wrapper: ${String(err)}`);
		return;
	}
	const service = resolveGatewayService();
	let loaded = false;
	let existingServiceEnv;
	let existingServiceCommand = null;
	try {
		loaded = await service.isLoaded({ env: process.env });
	} catch (err) {
		if (isNonFatalSystemdInstallProbeError(err)) loaded = false;
		else {
			fail(`Gateway service check failed: ${String(err)}`);
			return;
		}
	}
	existingServiceCommand = await service.readCommand(process.env).catch(() => null);
	existingServiceEnv = existingServiceCommand?.environment;
	const installEnv = mergeInstallInvocationEnv({
		env: process.env,
		existingServiceEnv
	});
	if (!wrapperPath) try {
		wrapperPath = await resolveOpenClawWrapperPath(installEnv[OPENCLAW_WRAPPER_ENV_KEY]);
	} catch (err) {
		fail(`Invalid ${OPENCLAW_WRAPPER_ENV_KEY}: ${String(err)}`);
		return;
	}
	if (loaded) {
		if (!opts.force) {
			const autoRefreshMessage = await getGatewayServiceAutoRefreshMessage({
				currentCommand: existingServiceCommand,
				env: process.env,
				installEnv,
				port,
				runtime: runtimeRaw,
				wrapperPath,
				existingEnvironment: existingServiceEnv,
				existingEnvironmentValueSources: existingServiceCommand?.environmentValueSources,
				config: cfg
			});
			if (autoRefreshMessage) if (json) warnings.push(autoRefreshMessage);
			else defaultRuntime.log(autoRefreshMessage);
			else {
				emit({
					ok: true,
					result: "already-installed",
					message: `Gateway service already ${service.loadedText}.`,
					service: buildDaemonServiceSnapshot(service, loaded)
				});
				if (!json) {
					defaultRuntime.log(`Gateway service already ${service.loadedText}.`);
					defaultRuntime.log(`Reinstall with: ${formatCliCommand("openclaw gateway install --force")}`);
				}
				return;
			}
		}
	}
	const tokenResolution = await resolveGatewayInstallToken({
		config: cfg,
		configSnapshot,
		configWriteOptions,
		env: installEnv,
		explicitToken: opts.token,
		autoGenerateWhenMissing: true,
		persistGeneratedToken: true
	});
	if (tokenResolution.unavailableReason) {
		fail(`Gateway install blocked: ${tokenResolution.unavailableReason}`);
		return;
	}
	for (const warning of tokenResolution.warnings) if (json) warnings.push(warning);
	else defaultRuntime.log(warning);
	const { programArguments, workingDirectory, environment, environmentValueSources } = await buildGatewayInstallPlan({
		env: installEnv,
		port,
		runtime: runtimeRaw,
		wrapperPath,
		existingEnvironment: existingServiceEnv,
		existingEnvironmentValueSources: existingServiceCommand?.environmentValueSources,
		warn: (message) => {
			if (json) warnings.push(message);
			else defaultRuntime.log(message);
		},
		config: cfg
	});
	await installDaemonServiceAndEmit({
		serviceNoun: "Gateway",
		service,
		warnings,
		emit,
		fail,
		install: async () => {
			await service.install({
				env: installEnv,
				stdout,
				programArguments,
				workingDirectory,
				environment,
				environmentValueSources
			});
		}
	});
}
async function getGatewayServiceAutoRefreshMessage(params) {
	try {
		const currentCommand = params.currentCommand;
		if (!currentCommand) return;
		const currentEmbeddedToken = readEmbeddedGatewayToken(currentCommand);
		if (currentEmbeddedToken) {
			if (currentEmbeddedToken !== normalizeOptionalString((await buildGatewayInstallPlan({
				env: params.installEnv,
				port: params.port,
				runtime: params.runtime,
				wrapperPath: params.wrapperPath,
				existingEnvironment: params.existingEnvironment,
				existingEnvironmentValueSources: params.existingEnvironmentValueSources,
				warn: () => void 0,
				config: params.config
			})).environment.OPENCLAW_GATEWAY_TOKEN)) return "Gateway service OPENCLAW_GATEWAY_TOKEN differs from the current install plan; refreshing the install.";
		}
		if (Boolean(params.wrapperPath || normalizeOptionalString(params.installEnv["OPENCLAW_WRAPPER"]))) {
			const plannedInstall = await buildGatewayInstallPlan({
				env: params.installEnv,
				port: params.port,
				runtime: params.runtime,
				wrapperPath: params.wrapperPath,
				existingEnvironment: params.existingEnvironment,
				existingEnvironmentValueSources: params.existingEnvironmentValueSources,
				warn: () => void 0,
				config: params.config
			});
			if (plannedInstall.programArguments.join("\0") !== currentCommand.programArguments.join("\0")) return "Gateway service command differs from the current wrapper install plan; refreshing the install.";
			if (normalizeOptionalString(plannedInstall.environment["OPENCLAW_WRAPPER"]) !== normalizeOptionalString(currentCommand.environment?.["OPENCLAW_WRAPPER"])) return `Gateway service ${OPENCLAW_WRAPPER_ENV_KEY} differs from the current wrapper install plan; refreshing the install.`;
		}
		const currentExecPath = currentCommand.programArguments[0]?.trim();
		if (!currentExecPath) return;
		const currentEnvironment = currentCommand.environment ?? {};
		const currentNodeExtraCaCerts = currentEnvironment.NODE_EXTRA_CA_CERTS?.trim();
		const expectedNodeExtraCaCerts = resolveNodeStartupTlsEnvironment({
			env: {
				...params.env,
				...currentEnvironment,
				NODE_EXTRA_CA_CERTS: void 0
			},
			execPath: currentExecPath,
			includeDarwinDefaults: false
		}).NODE_EXTRA_CA_CERTS;
		if (!expectedNodeExtraCaCerts) return;
		if (currentNodeExtraCaCerts !== expectedNodeExtraCaCerts) return "Gateway service is missing the nvm TLS CA bundle; refreshing the install.";
		return;
	} catch {
		return;
	}
}
//#endregion
export { runDaemonInstall as n, mergeInstallInvocationEnv as t };
