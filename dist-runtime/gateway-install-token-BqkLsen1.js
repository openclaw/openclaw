import { Kx as collectConfigServiceEnvVars, Wb as readConfigFileSnapshot, Yb as writeConfigFile, ab as hasAmbiguousGatewayAuthModeConfig, g as loadAuthProfileStoreForSecretsRuntime, od as randomToken, rb as resolveSecretRefValues } from "./auth-profiles-DqxBs6Au.js";
import { a as hasConfiguredSecretInput, d as resolveSecretInputRef } from "./types.secrets-CgNgVfYE.js";
import { In as secretRefKey } from "./method-scopes-DDb5C1xl.js";
import { t as formatCliCommand } from "./command-format-CS805JpF.js";
import { m as resolveGatewayAuth, w as readGatewayTokenEnv } from "./config-VO8zzMSR.js";
import { l as resolveGatewayLaunchAgentLabel } from "./constants-C8ub4F0Y.js";
import { n as resolveDaemonInstallRuntimeInputs, r as resolveGatewayProgramArguments, t as emitDaemonInstallRuntimeWarning } from "./daemon-install-plan.shared-B7RGrAF1.js";
import { l as buildServiceEnvironment } from "./runtime-paths-cQOj5Aup.js";
//#region src/commands/daemon-install-helpers.ts
function collectAuthProfileServiceEnvVars(params) {
	const authStore = params.authStore ?? loadAuthProfileStoreForSecretsRuntime();
	const entries = {};
	for (const credential of Object.values(authStore.profiles)) {
		const ref = credential.type === "api_key" ? credential.keyRef : credential.type === "token" ? credential.tokenRef : void 0;
		if (!ref || ref.source !== "env") {continue;}
		const value = params.env[ref.id]?.trim();
		if (!value) {continue;}
		entries[ref.id] = value;
	}
	return entries;
}
async function buildGatewayInstallPlan(params) {
	const { devMode, nodePath } = await resolveDaemonInstallRuntimeInputs({
		env: params.env,
		runtime: params.runtime,
		devMode: params.devMode,
		nodePath: params.nodePath
	});
	const { programArguments, workingDirectory } = await resolveGatewayProgramArguments({
		port: params.port,
		dev: devMode,
		runtime: params.runtime,
		nodePath
	});
	await emitDaemonInstallRuntimeWarning({
		env: params.env,
		runtime: params.runtime,
		programArguments,
		warn: params.warn,
		title: "Gateway runtime"
	});
	const serviceEnvironment = buildServiceEnvironment({
		env: params.env,
		port: params.port,
		launchdLabel: process.platform === "darwin" ? resolveGatewayLaunchAgentLabel(params.env.OPENCLAW_PROFILE) : void 0
	});
	const environment = {
		...collectConfigServiceEnvVars(params.config),
		...collectAuthProfileServiceEnvVars({
			env: params.env,
			authStore: params.authStore
		})
	};
	Object.assign(environment, serviceEnvironment);
	return {
		programArguments,
		workingDirectory,
		environment
	};
}
function gatewayInstallErrorHint(platform = process.platform) {
	return platform === "win32" ? "Tip: native Windows now falls back to a per-user Startup-folder login item when Scheduled Task creation is denied; if install still fails, rerun from an elevated PowerShell or skip service install." : `Tip: rerun \`${formatCliCommand("openclaw gateway install")}\` after fixing the error.`;
}
//#endregion
//#region src/gateway/auth-install-policy.ts
function shouldRequireGatewayTokenForInstall(cfg, _env) {
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "token") {return true;}
	if (mode === "password" || mode === "none" || mode === "trusted-proxy") {return false;}
	if (hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults)) {return false;}
	const configServiceEnv = collectConfigServiceEnvVars(cfg);
	if (configServiceEnv.OPENCLAW_GATEWAY_PASSWORD?.trim() || configServiceEnv.CLAWDBOT_GATEWAY_PASSWORD?.trim()) {return false;}
	return true;
}
//#endregion
//#region src/commands/gateway-install-token.ts
function formatAmbiguousGatewayAuthModeReason() {
	return ["gateway.auth.token and gateway.auth.password are both configured while gateway.auth.mode is unset.", `Set ${formatCliCommand("openclaw config set gateway.auth.mode token")} or ${formatCliCommand("openclaw config set gateway.auth.mode password")}.`].join(" ");
}
async function resolveGatewayInstallToken(options) {
	const cfg = options.config;
	const warnings = [];
	const tokenRef = resolveSecretInputRef({
		value: cfg.gateway?.auth?.token,
		defaults: cfg.secrets?.defaults
	}).ref;
	const tokenRefConfigured = Boolean(tokenRef);
	const configToken = tokenRef || typeof cfg.gateway?.auth?.token !== "string" ? void 0 : cfg.gateway.auth.token.trim() || void 0;
	const explicitToken = options.explicitToken?.trim() || void 0;
	const envToken = readGatewayTokenEnv(options.env);
	if (hasAmbiguousGatewayAuthModeConfig(cfg)) {return {
		token: void 0,
		tokenRefConfigured,
		unavailableReason: formatAmbiguousGatewayAuthModeReason(),
		warnings
	};}
	const resolvedAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off"
	});
	const needsToken = shouldRequireGatewayTokenForInstall(cfg, options.env) && !resolvedAuth.allowTailscale;
	let token = explicitToken || configToken || (tokenRef ? void 0 : envToken);
	let unavailableReason;
	if (tokenRef && !token && needsToken) {try {
		const value = (await resolveSecretRefValues([tokenRef], {
			config: cfg,
			env: options.env
		})).get(secretRefKey(tokenRef));
		if (typeof value !== "string" || value.trim().length === 0) throw new Error("gateway.auth.token resolved to an empty or non-string value.");
		warnings.push("gateway.auth.token is SecretRef-managed; install will not persist a resolved token in service environment. Ensure the SecretRef is resolvable in the daemon runtime context.");
	} catch (err) {
		unavailableReason = `gateway.auth.token SecretRef is configured but unresolved (${String(err)}).`;
	}}
	const allowAutoGenerate = options.autoGenerateWhenMissing ?? false;
	const persistGeneratedToken = options.persistGeneratedToken ?? false;
	if (!token && needsToken && !tokenRef && allowAutoGenerate) {
		token = randomToken();
		warnings.push(persistGeneratedToken ? "No gateway token found. Auto-generated one and saving to config." : "No gateway token found. Auto-generated one for this run without saving to config.");
		if (persistGeneratedToken) {try {
			const snapshot = await readConfigFileSnapshot();
			if (snapshot.exists && !snapshot.valid) warnings.push("Warning: config file exists but is invalid; skipping token persistence.");
			else {
				const baseConfig = snapshot.exists ? snapshot.config : {};
				const existingTokenRef = resolveSecretInputRef({
					value: baseConfig.gateway?.auth?.token,
					defaults: baseConfig.secrets?.defaults
				}).ref;
				const baseConfigToken = existingTokenRef || typeof baseConfig.gateway?.auth?.token !== "string" ? void 0 : baseConfig.gateway.auth.token.trim() || void 0;
				if (!existingTokenRef && !baseConfigToken) await writeConfigFile({
					...baseConfig,
					gateway: {
						...baseConfig.gateway,
						auth: {
							...baseConfig.gateway?.auth,
							mode: baseConfig.gateway?.auth?.mode ?? "token",
							token
						}
					}
				});
				else if (baseConfigToken) token = baseConfigToken;
				else {
					token = void 0;
					warnings.push("Warning: gateway.auth.token is SecretRef-managed; skipping plaintext token persistence.");
				}
			}
		} catch (err) {
			warnings.push(`Warning: could not persist token to config: ${String(err)}`);
		}}
	}
	return {
		token,
		tokenRefConfigured,
		unavailableReason,
		warnings
	};
}
//#endregion
export { buildGatewayInstallPlan as n, gatewayInstallErrorHint as r, resolveGatewayInstallToken as t };
