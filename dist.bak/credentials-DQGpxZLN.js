//#region src/gateway/credentials.ts
function trimToUndefined(value) {
	if (typeof value !== "string") return;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : void 0;
}
function firstDefined(values) {
	for (const value of values) if (value) return value;
}
function readGatewayTokenEnv(env, includeLegacyEnv) {
	const primary = trimToUndefined(env.OPENCLAW_GATEWAY_TOKEN);
	if (primary) return primary;
	if (!includeLegacyEnv) return;
	return trimToUndefined(env.CLAWDBOT_GATEWAY_TOKEN);
}
function readGatewayPasswordEnv(env, includeLegacyEnv) {
	const primary = trimToUndefined(env.OPENCLAW_GATEWAY_PASSWORD);
	if (primary) return primary;
	if (!includeLegacyEnv) return;
	return trimToUndefined(env.CLAWDBOT_GATEWAY_PASSWORD);
}
function resolveGatewayCredentialsFromValues(params) {
	const env = params.env ?? process.env;
	const includeLegacyEnv = params.includeLegacyEnv ?? true;
	const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
	const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
	const configToken = trimToUndefined(params.configToken);
	const configPassword = trimToUndefined(params.configPassword);
	const tokenPrecedence = params.tokenPrecedence ?? "env-first";
	const passwordPrecedence = params.passwordPrecedence ?? "env-first";
	return {
		token: tokenPrecedence === "config-first" ? firstDefined([configToken, envToken]) : firstDefined([envToken, configToken]),
		password: passwordPrecedence === "config-first" ? firstDefined([configPassword, envPassword]) : firstDefined([envPassword, configPassword])
	};
}
function resolveGatewayCredentialsFromConfig(params) {
	const env = params.env ?? process.env;
	const includeLegacyEnv = params.includeLegacyEnv ?? true;
	const explicitToken = trimToUndefined(params.explicitAuth?.token);
	const explicitPassword = trimToUndefined(params.explicitAuth?.password);
	if (explicitToken || explicitPassword) return {
		token: explicitToken,
		password: explicitPassword
	};
	if (trimToUndefined(params.urlOverride)) return {};
	const mode = params.modeOverride ?? (params.cfg.gateway?.mode === "remote" ? "remote" : "local");
	const remote = params.cfg.gateway?.remote;
	const envToken = readGatewayTokenEnv(env, includeLegacyEnv);
	const envPassword = readGatewayPasswordEnv(env, includeLegacyEnv);
	const remoteToken = trimToUndefined(remote?.token);
	const remotePassword = trimToUndefined(remote?.password);
	const localToken = trimToUndefined(params.cfg.gateway?.auth?.token);
	const localPassword = trimToUndefined(params.cfg.gateway?.auth?.password);
	const localTokenPrecedence = params.localTokenPrecedence ?? "env-first";
	const localPasswordPrecedence = params.localPasswordPrecedence ?? "env-first";
	if (mode === "local") return resolveGatewayCredentialsFromValues({
		configToken: localToken ?? remoteToken,
		configPassword: localPassword ?? remotePassword,
		env,
		includeLegacyEnv,
		tokenPrecedence: localTokenPrecedence,
		passwordPrecedence: localPasswordPrecedence
	});
	const remoteTokenFallback = params.remoteTokenFallback ?? "remote-env-local";
	const remotePasswordFallback = params.remotePasswordFallback ?? "remote-env-local";
	const remoteTokenPrecedence = params.remoteTokenPrecedence ?? "remote-first";
	const remotePasswordPrecedence = params.remotePasswordPrecedence ?? "env-first";
	return {
		token: remoteTokenFallback === "remote-only" ? remoteToken : remoteTokenPrecedence === "env-first" ? firstDefined([
			envToken,
			remoteToken,
			localToken
		]) : firstDefined([
			remoteToken,
			envToken,
			localToken
		]),
		password: remotePasswordFallback === "remote-only" ? remotePassword : remotePasswordPrecedence === "env-first" ? firstDefined([
			envPassword,
			remotePassword,
			localPassword
		]) : firstDefined([
			remotePassword,
			envPassword,
			localPassword
		])
	};
}

//#endregion
export { resolveGatewayCredentialsFromValues as n, trimToUndefined as r, resolveGatewayCredentialsFromConfig as t };