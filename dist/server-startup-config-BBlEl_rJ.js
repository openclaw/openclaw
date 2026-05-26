import { t as isTruthyEnvValue } from "./env-DL0trrAI.js";
import { i as isNixMode } from "./paths-Cnwfh6dH.js";
import "./auth-e6hlqNhL.js";
import { n as resolveGatewayAuth } from "./auth-resolve-CX86Ah73.js";
import { A as applyConfigOverrides, f as readConfigFileSnapshotWithPluginMetadata } from "./io-5xE1dPMK.js";
import { n as formatConfigIssueLines } from "./issue-format-C1rff-gs.js";
import { t as formatInvalidConfigRecoveryHint } from "./config-recovery-hints-BC_43CAJ.js";
import { t as applyPluginAutoEnable } from "./plugin-auto-enable-DLIxCAM0.js";
import { n as evaluateGatewayAuthSurfaceStates, t as GATEWAY_AUTH_SURFACE_PATHS } from "./runtime-gateway-auth-surfaces-jpPUgOfc.js";
import { i as assertGatewayAuthNotKnownWeak, n as mergeGatewayAuthConfig, r as mergeGatewayTailscaleConfig, t as ensureGatewayStartupAuth } from "./startup-auth-BgvYjwgU.js";
//#region src/gateway/server-startup-config.ts
async function loadGatewayStartupConfigSnapshot(params) {
	const measure = params.measure ?? (async (_name, run) => await run());
	const snapshotRead = params.initialSnapshotRead ?? await measure("config.snapshot.read", () => readConfigFileSnapshotWithPluginMetadata({ measure }));
	const configSnapshot = snapshotRead.snapshot;
	const pluginMetadataSnapshot = snapshotRead.pluginMetadataSnapshot;
	const wroteConfig = false;
	if (configSnapshot.legacyIssues.length > 0 && isNixMode) throw new Error("Legacy config entries detected while running in Nix mode. Update your Nix config to the latest schema and restart.");
	if (configSnapshot.exists) assertValidGatewayStartupConfigSnapshot(configSnapshot, { includeDoctorHint: true });
	const autoEnable = params.minimalTestGateway ? {
		config: configSnapshot.config,
		changes: []
	} : await measure("config.snapshot.auto-enable", () => applyPluginAutoEnable({
		config: configSnapshot.sourceConfig,
		env: process.env,
		...pluginMetadataSnapshot?.manifestRegistry ? { manifestRegistry: pluginMetadataSnapshot.manifestRegistry } : {}
	}));
	if (autoEnable.changes.length === 0) return {
		snapshot: configSnapshot,
		wroteConfig,
		...pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}
	};
	params.log.info(`gateway: auto-enabled plugins for this runtime without writing config:\n${autoEnable.changes.map((entry) => `- ${entry}`).join("\n")}`);
	return {
		snapshot: withRuntimeConfig(configSnapshot, autoEnable.config),
		wroteConfig,
		...pluginMetadataSnapshot ? { pluginMetadataSnapshot } : {}
	};
}
function withRuntimeConfig(snapshot, runtimeConfig) {
	return {
		...snapshot,
		runtimeConfig,
		config: runtimeConfig
	};
}
function createRuntimeSecretsActivator(params) {
	let secretsDegraded = false;
	let secretsActivationTail = Promise.resolve();
	let secretsRuntimePromise = null;
	let authProfilesPromise = null;
	const loadSecretsRuntime = () => {
		secretsRuntimePromise ??= import("./runtime-B1-j01XX.js");
		return secretsRuntimePromise;
	};
	const loadAuthProfiles = () => {
		authProfilesPromise ??= import("./auth-profiles-D7QYZlkg.js");
		return authProfilesPromise;
	};
	const runWithSecretsActivationLock = async (operation) => {
		const run = secretsActivationTail.then(operation, operation);
		secretsActivationTail = run.then(() => void 0, () => void 0);
		return await run;
	};
	return async (config, activationParams) => await runWithSecretsActivationLock(async () => {
		try {
			const secretsRuntime = params.prepareRuntimeSecretsSnapshot && params.activateRuntimeSecretsSnapshot ? null : await loadSecretsRuntime();
			const prepareRuntimeSecretsSnapshot = params.prepareRuntimeSecretsSnapshot ?? secretsRuntime.prepareSecretsRuntimeSnapshot;
			const activateRuntimeSecretsSnapshot = params.activateRuntimeSecretsSnapshot ?? secretsRuntime.activateSecretsRuntimeSnapshot;
			const loadAuthStore = activationParams.reason === "startup" || activationParams.reason === "restart-check" ? (await loadAuthProfiles()).loadAuthProfileStoreWithoutExternalProfiles : void 0;
			const prepared = await prepareRuntimeSecretsSnapshot({
				config: pruneSkippedStartupSecretSurfaces(config),
				...loadAuthStore ? { loadAuthStore } : {}
			});
			assertRuntimeGatewayAuthNotKnownWeak(prepared.config);
			if (activationParams.activate) {
				activateRuntimeSecretsSnapshot(prepared);
				logGatewayAuthSurfaceDiagnostics(prepared, params.logSecrets);
			}
			for (const warning of prepared.warnings) params.logSecrets.warn(`[${warning.code}] ${warning.message}`);
			if (secretsDegraded) {
				const recoveredMessage = "Secret resolution recovered; runtime remained on last-known-good during the outage.";
				params.logSecrets.info(`[SECRETS_RELOADER_RECOVERED] ${recoveredMessage}`);
				params.emitStateEvent("SECRETS_RELOADER_RECOVERED", recoveredMessage, prepared.config);
			}
			secretsDegraded = false;
			return prepared;
		} catch (err) {
			const details = String(err);
			if (!secretsDegraded) {
				params.logSecrets.error?.(`[SECRETS_RELOADER_DEGRADED] ${details}`);
				if (activationParams.reason !== "startup") params.emitStateEvent("SECRETS_RELOADER_DEGRADED", `Secret resolution failed; runtime remains on last-known-good snapshot. ${details}`, config);
			} else params.logSecrets.warn(`[SECRETS_RELOADER_DEGRADED] ${details}`);
			secretsDegraded = true;
			if (activationParams.reason === "startup") throw new Error(`Startup failed: required secrets are unavailable. ${details}`, { cause: err });
			throw err;
		}
	});
}
function assertValidGatewayStartupConfigSnapshot(snapshot, options = {}) {
	if (snapshot.valid) return;
	const issues = snapshot.issues.length > 0 ? formatConfigIssueLines(snapshot.issues, "", { normalizeRoot: true }).join("\n") : "Unknown validation issue.";
	const doctorHint = options.includeDoctorHint ? `\n${formatInvalidConfigRecoveryHint()}` : "";
	throw new Error(`Invalid config at ${snapshot.path}.\n${issues}${doctorHint}`);
}
async function prepareGatewayStartupConfig(params) {
	assertValidGatewayStartupConfigSnapshot(params.configSnapshot);
	const runtimeConfig = applyConfigOverrides(params.configSnapshot.config);
	const startupPreflightConfig = applyGatewayAuthOverridesForStartupPreflight(runtimeConfig, {
		auth: params.authOverride,
		tailscale: params.tailscaleOverride
	});
	const preflightConfig = hasActiveGatewayAuthSecretRef(startupPreflightConfig) ? (await params.activateRuntimeSecrets(startupPreflightConfig, {
		reason: "startup",
		activate: false
	})).config : startupPreflightConfig;
	const preflightAuthOverride = typeof preflightConfig.gateway?.auth?.token === "string" || typeof preflightConfig.gateway?.auth?.password === "string" ? {
		...params.authOverride,
		...typeof preflightConfig.gateway?.auth?.token === "string" ? { token: preflightConfig.gateway.auth.token } : {},
		...typeof preflightConfig.gateway?.auth?.password === "string" ? { password: preflightConfig.gateway.auth.password } : {}
	} : params.authOverride;
	const authBootstrap = await ensureGatewayStartupAuth({
		cfg: runtimeConfig,
		env: process.env,
		authOverride: preflightAuthOverride,
		tailscaleOverride: params.tailscaleOverride,
		persist: params.persistStartupAuth ?? false,
		baseHash: params.configSnapshot.hash
	});
	const runtimeStartupConfig = applyGatewayAuthOverridesForStartupPreflight(authBootstrap.cfg, {
		auth: params.authOverride,
		tailscale: params.tailscaleOverride
	});
	const activatedConfig = (await params.activateRuntimeSecrets(runtimeStartupConfig, {
		reason: "startup",
		activate: true
	})).config;
	return {
		...authBootstrap,
		cfg: activatedConfig
	};
}
function hasActiveGatewayAuthSecretRef(config) {
	const states = evaluateGatewayAuthSurfaceStates({
		config,
		defaults: config.secrets?.defaults,
		env: process.env
	});
	return GATEWAY_AUTH_SURFACE_PATHS.some((path) => {
		const state = states[path];
		return state.hasSecretRef && state.active;
	});
}
function pruneSkippedStartupSecretSurfaces(config) {
	if (!(isTruthyEnvValue(process.env.OPENCLAW_SKIP_CHANNELS) || isTruthyEnvValue(process.env.OPENCLAW_SKIP_PROVIDERS)) || !config.channels) return config;
	return {
		...config,
		channels: void 0
	};
}
function assertRuntimeGatewayAuthNotKnownWeak(config) {
	assertGatewayAuthNotKnownWeak(resolveGatewayAuth({
		authConfig: config.gateway?.auth,
		env: process.env,
		tailscaleMode: config.gateway?.tailscale?.mode ?? "off"
	}));
}
function logGatewayAuthSurfaceDiagnostics(prepared, logSecrets) {
	const states = evaluateGatewayAuthSurfaceStates({
		config: prepared.sourceConfig,
		defaults: prepared.sourceConfig.secrets?.defaults,
		env: process.env
	});
	const inactiveWarnings = /* @__PURE__ */ new Map();
	for (const warning of prepared.warnings) {
		if (warning.code !== "SECRETS_REF_IGNORED_INACTIVE_SURFACE") continue;
		inactiveWarnings.set(warning.path, warning.message);
	}
	for (const path of GATEWAY_AUTH_SURFACE_PATHS) {
		const state = states[path];
		if (!state.hasSecretRef) continue;
		const stateLabel = state.active ? "active" : "inactive";
		const details = (!state.active && inactiveWarnings.get(path) ? inactiveWarnings.get(path) : void 0) ?? state.reason;
		logSecrets.info(`[SECRETS_GATEWAY_AUTH_SURFACE] ${path} is ${stateLabel}. ${details}`);
	}
}
function applyGatewayAuthOverridesForStartupPreflight(config, overrides) {
	if (!overrides.auth && !overrides.tailscale) return config;
	return {
		...config,
		gateway: {
			...config.gateway,
			auth: mergeGatewayAuthConfig(config.gateway?.auth, overrides.auth),
			tailscale: mergeGatewayTailscaleConfig(config.gateway?.tailscale, overrides.tailscale)
		}
	};
}
//#endregion
export { assertValidGatewayStartupConfigSnapshot, createRuntimeSecretsActivator, loadGatewayStartupConfigSnapshot, prepareGatewayStartupConfig };
