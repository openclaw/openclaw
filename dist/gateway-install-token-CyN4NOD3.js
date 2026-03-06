import { Cn as secretRefKey, Ft as resolveSecretRefValues, an as writeConfigFile, qr as collectConfigServiceEnvVars, tn as readConfigFileSnapshot } from "./model-selection-COYmqEoi.js";
import { L as resolveSecretInputRef, j as hasConfiguredSecretInput } from "./registry-DBb6KIXY.js";
import { t as formatCliCommand } from "./command-format-DgBEhw5P.js";
import { a as resolveGatewayAuth } from "./auth-_bAG6RXt.js";
import { n as hasAmbiguousGatewayAuthModeConfig } from "./auth-mode-policy-BCCDvwZp.js";
import { h as randomToken } from "./onboard-helpers-DkoVky3L.js";

//#region src/gateway/auth-install-policy.ts
function shouldRequireGatewayTokenForInstall(cfg, _env) {
	const mode = cfg.gateway?.auth?.mode;
	if (mode === "token") return true;
	if (mode === "password" || mode === "none" || mode === "trusted-proxy") return false;
	if (hasConfiguredSecretInput(cfg.gateway?.auth?.password, cfg.secrets?.defaults)) return false;
	const configServiceEnv = collectConfigServiceEnvVars(cfg);
	if (Boolean(configServiceEnv.OPENCLAW_GATEWAY_PASSWORD?.trim() || configServiceEnv.CLAWDBOT_GATEWAY_PASSWORD?.trim())) return false;
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
	const envToken = options.env.OPENCLAW_GATEWAY_TOKEN?.trim() || options.env.CLAWDBOT_GATEWAY_TOKEN?.trim();
	if (hasAmbiguousGatewayAuthModeConfig(cfg)) return {
		token: void 0,
		tokenRefConfigured,
		unavailableReason: formatAmbiguousGatewayAuthModeReason(),
		warnings
	};
	const resolvedAuth = resolveGatewayAuth({
		authConfig: cfg.gateway?.auth,
		tailscaleMode: cfg.gateway?.tailscale?.mode ?? "off"
	});
	const needsToken = shouldRequireGatewayTokenForInstall(cfg, options.env) && !resolvedAuth.allowTailscale;
	let token = explicitToken || configToken || (tokenRef ? void 0 : envToken);
	let unavailableReason;
	if (tokenRef && !token && needsToken) try {
		const value = (await resolveSecretRefValues([tokenRef], {
			config: cfg,
			env: options.env
		})).get(secretRefKey(tokenRef));
		if (typeof value !== "string" || value.trim().length === 0) throw new Error("gateway.auth.token resolved to an empty or non-string value.");
		warnings.push("gateway.auth.token is SecretRef-managed; install will not persist a resolved token in service environment. Ensure the SecretRef is resolvable in the daemon runtime context.");
	} catch (err) {
		unavailableReason = `gateway.auth.token SecretRef is configured but unresolved (${String(err)}).`;
	}
	const allowAutoGenerate = options.autoGenerateWhenMissing ?? false;
	const persistGeneratedToken = options.persistGeneratedToken ?? false;
	if (!token && needsToken && !tokenRef && allowAutoGenerate) {
		token = randomToken();
		warnings.push(persistGeneratedToken ? "No gateway token found. Auto-generated one and saving to config." : "No gateway token found. Auto-generated one for this run without saving to config.");
		if (persistGeneratedToken) try {
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
		}
	}
	return {
		token,
		tokenRefConfigured,
		unavailableReason,
		warnings
	};
}

//#endregion
export { resolveGatewayInstallToken as t };